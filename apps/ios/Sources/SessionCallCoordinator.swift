import Foundation
import Combine
import UIKit
import WebKit
import CallKit
import AVFoundation
import Intents

/// One native call at a time; the web app remains the authority for room membership.
/// Web audio begins only after CallKit activates the audio session.
final class SessionCallCoordinator: NSObject, ObservableObject {
    static let shared = SessionCallCoordinator()
    let origin: URL?
    private let controller = CXCallController()
    private let provider: CXProvider
    private var current: ActiveCall?
    private var pendingRoute: SessionCallRoute?

    private struct ActiveCall {
        let id: UUID
        let route: SessionCallRoute
        var title: String
        var connected = false
        var audioActive = false
    }

    lazy var webView: WKWebView = {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.userContentController.add(WeakMessageHandler(self), name: "cloudbotCall")
        let view = WKWebView(frame: .zero, configuration: configuration)
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
    }()

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
    }

    func open(deepLink: URL) {
        guard let route = SessionCallRoute(deepLink: deepLink) else { return }
        open(route: route)
    }

    @discardableResult
    func resume(activity: NSUserActivity) -> Bool {
        let handle: String?
        if let intent = activity.interaction?.intent as? INStartCallIntent {
            handle = intent.contacts?.first?.personHandle?.value
        } else if let intent = activity.interaction?.intent as? INStartAudioCallIntent {
            handle = intent.contacts?.first?.personHandle?.value
        } else {
            return false
        }
        guard let handle, let route = SessionCallRoute(roomID: handle) else { return false }
        open(route: route)
        return true
    }

    private func open(route: SessionCallRoute) {
        guard let origin else { pendingRoute = route; return }
        // Recents and external links open the room's call sheet. They never grant access
        // or start recording; the signed-in user presses Start after room validation.
        if let current {
            if current.route != route {
                emit(action: "error", route: route, message: "현재 통화를 종료한 뒤 다른 대화에 전화해 주세요.")
            }
            return
        }
        webView.load(URLRequest(url: route.pageURL(origin: origin)))
    }

    private func start(route: SessionCallRoute, title: String) {
        guard current == nil else {
            emit(action: "error", route: route, message: "이미 통화 중입니다.")
            return
        }
        let displayTitle = title.isEmpty ? "새 대화" : String(title.prefix(200))
        let call = ActiveCall(id: UUID(), route: route, title: displayTitle)
        current = call
        let action = CXStartCallAction(call: call.id, handle: CXHandle(type: .generic, value: route.handle))
        action.isVideo = false
        let update = CXCallUpdate()
        update.remoteHandle = action.handle
        update.localizedCallerName = displayTitle
        update.hasVideo = false
        update.supportsHolding = false
        update.supportsGrouping = false
        update.supportsUngrouping = false
        update.supportsDTMF = false
        controller.request(CXTransaction(action: action)) { [weak self] error in
            DispatchQueue.main.async {
                guard let self, self.current?.id == call.id else { return }
                if error != nil {
                    self.finish(reason: .failed, message: "시스템 통화를 시작할 수 없습니다.")
                } else {
                    self.provider.reportCall(with: call.id, updated: update)
                }
            }
        }
    }

    private func end(route: SessionCallRoute) {
        guard let call = current, call.route == route else { return }
        controller.request(CXTransaction(action: CXEndCallAction(call: call.id))) { [weak self] error in
            guard error != nil else { return }
            DispatchQueue.main.async {
                guard self?.current?.id == call.id else { return }
                self?.finish(reason: .failed, message: "통화를 종료했습니다.")
            }
        }
    }

    private func finish(reason: CXCallEndedReason? = nil, message: String? = nil) {
        guard let call = current else { return }
        current = nil
        if let reason { provider.reportCall(with: call.id, endedAt: Date(), reason: reason) }
        emit(action: message == nil ? "ended" : "error", route: call.route, message: message)
    }

    private func emit(action: String, route: SessionCallRoute, message: String? = nil) {
        var payload: [String: String] = ["action": action, "roomId": route.handle]
        if let message { payload["message"] = message }
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        // JSON serialization prevents titles/error content from becoming JavaScript source.
        webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('cloudbot:native-call',{detail:\(json)}));")
    }
}

extension SessionCallCoordinator: WKScriptMessageHandler {
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let origin, message.name == "cloudbotCall", message.frameInfo.isMainFrame,
              CloudBotOrigin.matches(message.frameInfo.request.url, configured: origin),
              CloudBotOrigin.matches(webView.url, configured: origin),
              let payload = message.body as? [String: Any], let action = payload["action"] as? String,
              let id = payload["roomId"] as? String, let route = SessionCallRoute(roomID: id) else { return }
        // `payload.origin` is deliberately ignored. Only the installed app's origin is trusted.
        switch action {
        case "start":
            start(route: route, title: (payload["roomTitle"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines))
        case "end":
            end(route: route)
        case "connected":
            guard var call = current, call.route == route, call.audioActive, !call.connected else { return }
            call.connected = true
            current = call
            provider.reportOutgoingCall(with: call.id, connectedAt: Date())
        case "failed":
            guard current?.route == route else { return }
            finish(reason: .failed, message: "음성 연결을 시작할 수 없습니다. 앱에서 마이크 권한과 연결 상태를 확인해 주세요.")
        case "title":
            guard var call = current, call.route == route,
                  let title = payload["roomTitle"] as? String else { return }
            let value = String(title.trimmingCharacters(in: .whitespacesAndNewlines).prefix(200))
            guard !value.isEmpty, value != call.title else { return }
            call.title = value
            current = call
            let update = CXCallUpdate()
            update.remoteHandle = CXHandle(type: .generic, value: call.route.handle)
            update.localizedCallerName = value
            provider.reportCall(with: call.id, updated: update)
        default: break
        }
    }
}

extension SessionCallCoordinator: CXProviderDelegate {
    func providerDidReset(_ provider: CXProvider) { finish() }

    func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        guard let call = current, call.id == action.callUUID else { action.fail(); return }
        do {
            try AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .voiceChat,
                                                           options: [.allowBluetooth, .defaultToSpeaker])
            provider.reportOutgoingCall(with: call.id, startedConnectingAt: Date())
            action.fulfill()
            // CallKit owns activation. Do not setActive(true) or start web audio here.
        } catch {
            action.fail()
            finish(reason: .failed, message: "통화 오디오를 준비할 수 없습니다.")
        }
    }

    func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        guard var call = current, !call.audioActive else { return }
        call.audioActive = true
        current = call
        emit(action: "active", route: call.route)
    }

    func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        if current != nil { finish(reason: .remoteEnded, message: "시스템에서 통화 오디오가 중단되었습니다.") }
    }

    func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        guard current?.id == action.callUUID else { action.fail(); return }
        finish()
        action.fulfill()
    }

    func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        guard let call = current, call.id == action.callUUID else { action.fail(); return }
        emit(action: action.isMuted ? "muted" : "unmuted", route: call.route)
        action.fulfill()
    }

    func provider(_ provider: CXProvider, timedOutPerforming action: CXAction) {
        finish(reason: .failed, message: "시스템 통화 연결 시간이 초과되었습니다.")
    }
}

extension SessionCallCoordinator: WKNavigationDelegate, WKUIDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let origin, let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if CloudBotOrigin.matches(url, configured: origin) {
            decisionHandler(.allow)
        } else {
            decisionHandler(.cancel)
            if navigationAction.navigationType == .linkActivated, ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
                UIApplication.shared.open(url)
            }
        }
    }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor securityOrigin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        guard let origin, frame.isMainFrame, type == .microphone,
              securityOrigin.protocol == "https", securityOrigin.host.lowercased() == origin.host?.lowercased(),
              (securityOrigin.port == 0 ? 443 : securityOrigin.port) == (origin.port ?? 443) else {
            decisionHandler(.deny)
            return
        }
        decisionHandler(.prompt)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        finish(reason: .failed, message: "앱 화면이 다시 시작되어 통화를 종료했습니다.")
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
