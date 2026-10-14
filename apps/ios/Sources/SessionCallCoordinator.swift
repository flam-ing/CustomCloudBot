import Foundation
import Combine
import UIKit
import WebKit
import CallKit
import AVFoundation
import Intents

/// CallKit, networking and audio live outside WKWebView, including when the phone locks.
/// The immutable room UUID is the call address; the server remains the authority for access.
@MainActor
final class SessionCallCoordinator: NSObject, ObservableObject {
    static let shared = SessionCallCoordinator()
    let origin: URL?
    @Published private(set) var callTitle = ""
    @Published private(set) var callState = "ended"
    @Published private(set) var callText = ""
    @Published private(set) var isMuted = false
    @Published private(set) var isCalling = false
    @Published var showingCallControls = false
    @Published var errorMessage: String?

    private let controller = CXCallController()
    private let provider: CXProvider
    private let audio = NativeVoiceAudio()
    private var client: NativeCallClient?
    private var current: ActiveCall?
    private var pendingRoute: SessionCallRoute?
    private var cachedWebView: WKWebView?
    private var trustedPageLoaded = false
    private var startTask: Task<Void, Never>?
    private var startToken: UUID?
    private var pendingStartRoute: SessionCallRoute?
    private var credentialsRevision = 0
    private var observers: [NSObjectProtocol] = []

    @MainActor
    private final class ActiveCall {
        let id = UUID()
        let route: SessionCallRoute
        let botID: String
        let userID: String
        let model: String
        let effort: String
        var title: String
        var connected = false
        var audioActive = false
        var audioGeneration = 0
        var muted = false
        var state = "connecting"
        var text = ""
        var startedAt: Date?
        var turn = 0
        var turnTask: Task<Void, Never>?
        var speechTask: Task<Void, Never>?
        var heartbeatTask: Task<Void, Never>?
        var pendingReply: String?

        init(route: SessionCallRoute, context: NativeCallContext, model: String, effort: String) {
            self.route = route
            self.title = context.title
            self.botID = context.botID
            self.userID = context.userID
            self.model = model
            self.effort = effort
        }
    }

    var webView: WKWebView {
        if let cachedWebView { return cachedWebView }
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.userContentController.add(WeakMessageHandler(self), name: "cloudbotCall")
        configuration.userContentController.addUserScript(WKUserScript(
            source: "Object.defineProperty(window,'cloudbotNativeVoice',{value:Object.freeze({version:2}),writable:false,configurable:false});",
            injectionTime: .atDocumentStart, forMainFrameOnly: true))
        configuration.websiteDataStore.httpCookieStore.add(self)
        let view = WKWebView(frame: .zero, configuration: configuration)
        cachedWebView = view
        view.navigationDelegate = self
        view.uiDelegate = self
        view.isOpaque = false
        view.backgroundColor = .systemBackground
        view.allowsBackForwardNavigationGestures = true
        if let origin {
            view.load(URLRequest(url: pendingRoute?.pageURL(origin: origin) ?? origin))
            pendingRoute = nil
        }
        return view
    }

    private override init() {
        origin = CloudBotOrigin.parse(Bundle.main.object(forInfoDictionaryKey: "CloudBotOrigin") as? String ?? "")
        let configuration = CXProviderConfiguration(localizedName: "CustomCloudBot")
        configuration.supportedHandleTypes = [.generic]
        configuration.supportsVideo = false
        configuration.includesCallsInRecents = true
        configuration.maximumCallGroups = 1
        configuration.maximumCallsPerCallGroup = 1
        provider = CXProvider(configuration: configuration)
        super.init()
        provider.setDelegate(self, queue: .main)
        if let origin {
            let client = NativeCallClient(origin: origin)
            self.client = client
            client.onCredentialsChanged = { [weak self] in
                guard let self else { return }
                self.credentialsRevision += 1
                if self.current != nil {
                    self.finish(reason: .remoteEnded, message: "로그인이 바뀌어 통화를 종료했어요.")
                }
            }
        }
        audio.onUtterance = { [weak self] data in self?.processUtterance(data) }
        audio.onState = { [weak self] state in
            guard let self, let call = self.current, call.audioActive,
                  call.turnTask == nil, call.pendingReply == nil, state != "stopped" else { return }
            self.update(call, state: state)
        }
        audio.onFailure = { [weak self] message in self?.finish(reason: .failed, message: message) }
        observers.append(NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
                Task { @MainActor in self?.interruption(note) }
            })
        observers.append(NotificationCenter.default.addObserver(
            forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in self?.routeChanged() }
            })
    }

    func open(deepLink: URL) {
        guard let route = SessionCallRoute(deepLink: deepLink) else { return }
        navigate(to: route)
    }

    @discardableResult
    func resume(activity: NSUserActivity) -> Bool {
        let handle: String?
        if let intent = activity.interaction?.intent as? INStartCallIntent {
            handle = intent.contacts?.first?.personHandle?.value
                ?? intent.callRecordToCallBack?.participants?.first?.personHandle?.value
        } else if let intent = activity.interaction?.intent as? INStartAudioCallIntent {
            handle = intent.contacts?.first?.personHandle?.value
        } else { return false }
        guard let handle, let route = SessionCallRoute(roomID: handle) else { return false }
        // Tapping Recents is the user's call action. Revalidate the saved login and this
        // exact room, then start directly; no web page or second Start press is required.
        showingCallControls = true
        if current?.route == route || pendingStartRoute == route { return true }
        start(route: route, model: "", effort: "", useWebIdentity: false)
        navigate(to: route)
        return true
    }

    private func navigate(to route: SessionCallRoute) {
        guard let origin else { pendingRoute = route; return }
        if let call = current, call.route != route {
            errorMessage = "현재 통화는 ‘\(call.title)’에 연결되어 있어요. 종료한 뒤 다른 대화에 전화해 주세요."
            return
        }
        pendingRoute = route
        // Cold-start Recents does not instantiate WebKit as a prerequisite for calling.
        if let view = cachedWebView {
            trustedPageLoaded = false
            view.load(URLRequest(url: route.pageURL(origin: origin)))
            pendingRoute = nil
        }
    }

    private func start(route: SessionCallRoute, model: String, effort: String, useWebIdentity: Bool) {
        guard current == nil, startToken == nil, let client else {
            if current?.route == route || pendingStartRoute == route { emitSnapshot() }
            else { errorMessage = "이미 다른 통화를 연결하고 있어요." }
            return
        }
        let token = UUID()
        startToken = token
        pendingStartRoute = route
        callTitle = "대화 연결 중"
        callState = "connecting"
        callText = ""
        isCalling = true
        emit(route: route, state: "connecting")
        startTask = Task { [weak self] in
            guard let self else { return }
            do {
                if useWebIdentity, let view = self.cachedWebView {
                    do {
                        try await client.synchronizeCookies(from: view.configuration.websiteDataStore.httpCookieStore)
                    } catch is CancellationError {
                        // A cookie observer may have started a newer snapshot at the same time.
                        guard !Task.isCancelled, self.startToken == token else { return }
                        try await client.synchronizeCookies(from: view.configuration.websiteDataStore.httpCookieStore)
                    }
                }
                let revision = self.credentialsRevision
                let context = try await client.prepare(roomID: route.handle)
                guard !Task.isCancelled, self.startToken == token else { return }
                guard self.credentialsRevision == revision else { throw CallStartError.identityChanged }
                let allowed = await self.microphonePermission()
                guard !Task.isCancelled, self.startToken == token else { return }
                guard self.credentialsRevision == revision else { throw CallStartError.identityChanged }
                guard allowed else { throw CallStartError.microphoneDenied }
                // Permission prompts can stay open for minutes; membership must still be current.
                let latestTitle = try await client.validate(roomID: route.handle)
                guard !Task.isCancelled, self.startToken == token else { return }
                guard self.credentialsRevision == revision else { throw CallStartError.identityChanged }
                let call = ActiveCall(route: route, context: context, model: model, effort: effort)
                call.title = latestTitle
                self.current = call
                self.startToken = nil
                self.pendingStartRoute = nil
                self.startTask = nil
                self.update(call, state: "connecting")
                let action = CXStartCallAction(call: call.id, handle: CXHandle(type: .generic, value: route.handle))
                action.isVideo = false
                self.controller.request(CXTransaction(action: action)) { [weak self] error in
                    Task { @MainActor in
                        guard let self, self.current === call else { return }
                        if error != nil { self.finish(reason: .failed, message: "시스템 통화를 시작할 수 없습니다.") }
                        else { self.reportTitle(call) }
                    }
                }
            } catch {
                guard self.startToken == token else { return }
                self.startToken = nil
                self.pendingStartRoute = nil
                self.startTask = nil
                client.cancel()
                self.isCalling = false
                self.callState = "error"
                self.callText = error.localizedDescription
                self.errorMessage = error.localizedDescription
                self.emit(route: route, state: "error", text: error.localizedDescription)
            }
        }
    }

    private func microphonePermission() async -> Bool {
        switch AVAudioSession.sharedInstance().recordPermission {
        case .granted: return true
        case .denied: return false
        case .undetermined:
            return await withCheckedContinuation { continuation in
                AVAudioSession.sharedInstance().requestRecordPermission { continuation.resume(returning: $0) }
            }
        @unknown default: return false
        }
    }

    func endCall() {
        if startToken != nil {
            let route = pendingStartRoute
            pendingStartRoute = nil
            startToken = nil
            startTask?.cancel(); startTask = nil
            client?.cancel()
            isCalling = false; callState = "ended"; showingCallControls = false
            emit(route: route, state: "ended")
        }
        guard let call = current else { return }
        controller.request(CXTransaction(action: CXEndCallAction(call: call.id))) { [weak self] error in
            guard error != nil else { return }
            Task { @MainActor in
                guard let self, self.current === call else { return }
                self.finish(reason: .remoteEnded)
            }
        }
    }

    func toggleMuted() { setMuted(!isMuted) }
    func finishUtterance() { if current?.audioActive == true { audio.finishUtterance() } }

    private func setMuted(_ muted: Bool) {
        guard let call = current else { return }
        controller.request(CXTransaction(action: CXSetMutedCallAction(call: call.id, muted: muted))) { [weak self] error in
            guard error != nil else { return }
            Task { @MainActor in self?.errorMessage = "마이크 상태를 바꾸지 못했어요. 다시 눌러 주세요." }
        }
    }

    private func finish(reason: CXCallEndedReason? = nil, message: String? = nil) {
        guard let call = current else { return }
        current = nil
        call.turnTask?.cancel(); call.speechTask?.cancel(); call.heartbeatTask?.cancel()
        audio.stop()
        client?.cancel()
        if let reason { provider.reportCall(with: call.id, endedAt: Date(), reason: reason) }
        isCalling = false; isMuted = false
        callState = message == nil ? "ended" : "error"
        callText = message ?? "통화가 끝났어요."
        if let message { errorMessage = message }
        emit(route: call.route, state: callState, text: callText, title: call.title, userID: call.userID)
    }

    private func processUtterance(_ data: Data) {
        guard let call = current, call.audioActive, call.turnTask == nil,
              call.pendingReply == nil, let client else { return }
        call.turn += 1
        let nonce = "call:\(call.id.uuidString.lowercased()):\(call.turn)"
        call.turnTask = Task { [weak self] in
            guard let self else { return }
            do {
                self.update(call, state: "transcribing")
                let text = try await client.transcribe(data, roomID: call.route.handle)
                guard self.current === call, !Task.isCancelled else { return }
                if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    call.turnTask = nil
                    self.update(call, state: "listening", text: "잘 안 들렸어요. 다시 말씀해 주세요.")
                    if call.audioActive { self.audio.resumeListening() }
                    return
                }
                self.update(call, state: "waiting", text: text)
                let messageID = try await client.submit(text: text, roomID: call.route.handle,
                                                       nonce: nonce, model: call.model, effort: call.effort, botID: call.botID)
                guard self.current === call, !Task.isCancelled else { return }
                let reply = try await client.waitReply(roomID: call.route.handle, messageID: messageID)
                guard self.current === call, !Task.isCancelled else { return }
                self.refreshTitle(call, title: reply.title)
                call.pendingReply = reply.text
                call.turnTask = nil
                if call.audioActive { self.playReply(call) }
                else { self.update(call, state: "paused", text: reply.text) }
            } catch {
                guard self.current === call, !Task.isCancelled else { return }
                call.turnTask = nil
                self.finish(reason: .failed, message: error.localizedDescription)
            }
        }
    }

    private func playReply(_ call: ActiveCall) {
        guard current === call, call.audioActive, call.speechTask == nil, let text = call.pendingReply else { return }
        let generation = call.audioGeneration
        update(call, state: "speaking", text: text)
        call.speechTask = Task { [weak self] in
            guard let self else { return }
            await self.audio.speak(NativeCallProtocol.speechText(text))
            guard self.current === call, !Task.isCancelled,
                  call.audioActive, call.audioGeneration == generation else { return }
            call.speechTask = nil
            call.pendingReply = nil
            self.audio.resumeListening()
            self.emitSnapshot()
        }
    }

    private func monitorAccess(_ call: ActiveCall) {
        guard call.heartbeatTask == nil, let client else { return }
        call.heartbeatTask = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    try await Task.sleep(nanoseconds: 15_000_000_000)
                    guard let self, self.current === call else { return }
                    let title = try await client.validate(roomID: call.route.handle)
                    guard self.current === call, !Task.isCancelled else { return }
                    self.refreshTitle(call, title: title)
                } catch {
                    guard !Task.isCancelled, let self, self.current === call else { return }
                    self.finish(reason: .failed, message: error.localizedDescription)
                    return
                }
            }
        }
    }

    private func pauseAudio() {
        guard let call = current, call.audioActive else { return }
        call.audioActive = false
        call.audioGeneration += 1
        call.speechTask?.cancel(); call.speechTask = nil
        audio.stop()
        update(call, state: "paused")
        // A cellular interruption does not discard the room or resubmit an in-flight turn.
        // CallKit didActivate is the sole authority that resumes microphone/audio.
    }

    private func interruption(_ note: Notification) {
        guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        if type == .began { pauseAudio() }
    }

    private func routeChanged() {
        guard let call = current, call.audioActive else { return }
        do { try audio.restartForRouteChange() }
        catch { finish(reason: .failed, message: "통화 오디오 연결이 바뀌었어요. 다시 전화해 주세요.") }
    }

    private func refreshTitle(_ call: ActiveCall, title: String) {
        let trimmed = String(title.trimmingCharacters(in: .whitespacesAndNewlines).prefix(200))
        guard current === call, !trimmed.isEmpty, trimmed != call.title else { return }
        call.title = trimmed
        reportTitle(call)
        emitSnapshot()
    }

    private func reportTitle(_ call: ActiveCall) {
        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: call.route.handle)
        update.localizedCallerName = call.title
        update.hasVideo = false
        update.supportsHolding = false
        update.supportsGrouping = false
        update.supportsUngrouping = false
        update.supportsDTMF = false
        provider.reportCall(with: call.id, updated: update)
    }

    private func update(_ call: ActiveCall, state: String, text: String? = nil) {
        guard current === call else { return }
        call.state = state
        if let text { call.text = text }
        emitSnapshot()
    }

    private func emitSnapshot() {
        guard let call = current else {
            emit(route: pendingStartRoute, state: callState, text: callText, title: callTitle)
            return
        }
        callTitle = call.title; callState = call.state; callText = call.text
        isCalling = true; isMuted = call.muted
        emit(route: call.route, state: call.state, text: call.text, title: call.title,
             muted: call.muted, startedAt: call.startedAt, userID: call.userID)
    }

    private func emit(route: SessionCallRoute?, state: String, text: String = "", title: String = "",
                      muted: Bool = false, startedAt: Date? = nil, userID: String? = nil) {
        var payload: [String: Any] = ["action": "state", "roomId": route?.handle ?? "", "title": title,
                                      "state": state, "text": text, "muted": muted,
                                      "startedAt": startedAt.map { $0.timeIntervalSince1970 * 1000 } as Any? ?? NSNull()]
        if let userID { payload["userId"] = userID }
        guard let view = cachedWebView, let origin, CloudBotOrigin.matches(view.url, configured: origin),
              let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        // Emission is optional display work; do not create WebKit or depend on JS completion.
        view.evaluateJavaScript("window.dispatchEvent(new CustomEvent('cloudbot:native-call',{detail:\(json)}));")
    }

    private func synchronizeWebIdentity() {
        guard trustedPageLoaded, let view = cachedWebView, let origin,
              CloudBotOrigin.matches(view.url, configured: origin), let client else { return }
        Task { [weak self] in
            do { try await client.synchronizeCookies(from: view.configuration.websiteDataStore.httpCookieStore) }
            catch is CancellationError { /* A newer cookie snapshot owns synchronization. */ }
            catch {
                if self?.current != nil { self?.finish(reason: .failed, message: error.localizedDescription) }
            }
        }
    }

    private func logout() {
        startToken = nil; pendingStartRoute = nil; startTask?.cancel(); startTask = nil
        finish(reason: .remoteEnded, message: "로그아웃하여 통화를 종료했어요.")
        client?.clearCredentials()
        isCalling = false
    }

    private enum CallStartError: LocalizedError {
        case microphoneDenied, identityChanged
        var errorDescription: String? {
            switch self {
            case .microphoneDenied: return "아이폰 설정에서 CustomCloudBot의 마이크 권한을 허용해 주세요."
            case .identityChanged: return "로그인이 바뀌었어요. 현재 계정에서 다시 전화해 주세요."
            }
        }
    }
}

extension SessionCallCoordinator: WKScriptMessageHandler, WKHTTPCookieStoreObserver {
    func cookiesDidChange(in cookieStore: WKHTTPCookieStore) { synchronizeWebIdentity() }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let origin, let view = cachedWebView, message.name == "cloudbotCall", message.frameInfo.isMainFrame,
              CloudBotOrigin.matches(message.frameInfo.request.url, configured: origin),
              CloudBotOrigin.matches(view.url, configured: origin),
              let payload = message.body as? [String: Any], let action = payload["action"] as? String else { return }
        // Payload origin, title, userId and botId cannot grant access or select an identity.
        if action == "logout" { logout(); return }
        if action == "session" { trustedPageLoaded = true; synchronizeWebIdentity(); return }
        if action == "status" { emitSnapshot(); return }
        guard let id = payload["roomId"] as? String, let route = SessionCallRoute(roomID: id) else { return }
        switch action {
        case "start":
            let model = String((payload["model"] as? String ?? "").prefix(200))
            let effort = String((payload["effort"] as? String ?? "").prefix(16))
            start(route: route, model: model, effort: effort, useWebIdentity: true)
        case "end": if current?.route == route || startToken != nil { endCall() }
        case "mute": if current?.route == route, let muted = payload["muted"] as? Bool { setMuted(muted) }
        case "finish": if current?.route == route { finishUtterance() }
        default: break
        }
    }
}

extension SessionCallCoordinator: @preconcurrency CXProviderDelegate {
    func providerDidReset(_ provider: CXProvider) {
        if startToken != nil { endCall() }
        finish()
    }

    func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        guard let call = current, call.id == action.callUUID else { action.fail(); return }
        do {
            try AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .voiceChat,
                                                           options: [.allowBluetooth, .defaultToSpeaker])
            provider.reportOutgoingCall(with: call.id, startedConnectingAt: Date())
            reportTitle(call)
            action.fulfill()
            // CallKit activates the session. No setActive(true) or microphone work here.
        } catch {
            action.fail()
            finish(reason: .failed, message: "통화 오디오를 준비할 수 없습니다.")
        }
    }

    func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        guard let call = current, !call.audioActive else { return }
        call.audioActive = true
        call.audioGeneration += 1
        do {
            try audio.start()
            audio.setMuted(call.muted)
            if !call.connected {
                call.connected = true
                call.startedAt = Date()
                provider.reportOutgoingCall(with: call.id, connectedAt: call.startedAt)
                monitorAccess(call)
            }
            if call.pendingReply != nil { playReply(call) }
            else if call.turnTask != nil { audio.pauseListening(); update(call, state: "waiting") }
            else { audio.resumeListening() }
            emitSnapshot()
        } catch { finish(reason: .failed, message: "마이크를 연결할 수 없어요. 마이크 권한과 오디오 장치를 확인해 주세요.") }
    }

    func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) { pauseAudio() }

    func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        guard current?.id == action.callUUID else { action.fail(); return }
        finish()
        action.fulfill()
    }

    func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        guard let call = current, call.id == action.callUUID else { action.fail(); return }
        call.muted = action.isMuted
        audio.setMuted(call.muted)
        if call.turnTask == nil, call.pendingReply == nil, call.audioActive {
            update(call, state: call.muted ? "muted" : "listening")
        } else { emitSnapshot() }
        action.fulfill()
    }

    func provider(_ provider: CXProvider, timedOutPerforming action: CXAction) {
        guard let callAction = action as? CXCallAction, current?.id == callAction.callUUID else { return }
        finish(reason: .failed, message: "시스템 통화 연결 시간이 초과되었습니다.")
    }
}

extension SessionCallCoordinator: WKNavigationDelegate, WKUIDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let origin, let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if CloudBotOrigin.matches(url, configured: origin) { decisionHandler(.allow) }
        else {
            decisionHandler(.cancel)
            if navigationAction.navigationType == .linkActivated, ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
                UIApplication.shared.open(url)
            }
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        trustedPageLoaded = true
        synchronizeWebIdentity()
        emitSnapshot()
    }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor securityOrigin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        guard let origin, frame.isMainFrame, type == .microphone,
              securityOrigin.protocol == "https", securityOrigin.host.lowercased() == origin.host?.lowercased(),
              (securityOrigin.port == 0 ? 443 : securityOrigin.port) == (origin.port ?? 443), current == nil else {
            decisionHandler(.deny); return
        }
        decisionHandler(.prompt)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // Reload only the display. Native capture, the accepted message and call UUID survive.
        trustedPageLoaded = false
        webView.reload()
    }
}

private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}
