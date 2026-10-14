import Foundation
import Security
import WebKit

private struct NativeCredential: Codable, Equatable {
    let cookie: String
    let userID: String
    let expiresAt: Date
}

private struct NativeSession: Decodable {
    struct User: Decodable { let id: String }
    let user: User?
    let csrfToken: String?
}

private struct NativeRoomList: Decodable {
    struct Bot: Decodable { let id: String }
    let rooms: [NativeRoom]
    let bots: [Bot]
}

private struct NativeVoiceCapability: Decodable { let configured: Bool }
private struct NativeTranscript: Decodable { let text: String }
private struct NativeAccepted: Decodable { let messageId: String? }
private struct NativeAPIError: Decodable { let error: String? }

/// Never follows a redirect with a signed-in request to a different host.
private final class NativeOriginDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

/// Native HTTPS transport and device-only login storage. No WebView timer or cookie lookup
/// is needed while calling with a locked screen. Every operation still uses server auth.
@MainActor
final class NativeCallClient {
    let origin: URL
    var onCredentialsChanged: (() -> Void)?
    private var credential: NativeCredential?
    private var boundUserID: String?
    private var csrf = ""
    private var generation = 0
    private var syncGeneration = 0
    private let keychainService = "CustomCloudBot.native-call-session.v1"
    private let delegate = NativeOriginDelegate()
    private var session: URLSession!
    private let decoder = JSONDecoder()

    init(origin: URL) {
        self.origin = origin
        session = makeSession()
        credential = readCredential()
    }

    private func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.waitsForConnectivity = false
        configuration.timeoutIntervalForRequest = 20
        configuration.timeoutIntervalForResource = 60
        return URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
    }

    func cancel() {
        generation += 1
        boundUserID = nil
        csrf = ""
        session.invalidateAndCancel()
        session = makeSession()
    }

    func clearCredentials() {
        let hadCredential = credential != nil
        syncGeneration += 1
        cancel()
        credential = nil
        SecItemDelete(keychainQuery() as CFDictionary)
        if hadCredential { onCredentialsChanged?() }
    }

    func synchronizeCookies(from store: WKHTTPCookieStore) async throws {
        syncGeneration += 1
        let sync = syncGeneration
        let cookies = await store.allCookies()
        guard sync == syncGeneration else { throw CancellationError() }
        // Capture only the app's one exact-host HTTPS session, never a whole cookie jar.
        let matches = cookies.filter {
            $0.name == "community_session" && $0.domain.lowercased() == origin.host?.lowercased()
                && $0.path == "/" && $0.isSecure && NativeCallProtocol.validCookieValue($0.value)
                && ($0.expiresDate ?? Date.distantFuture) > Date()
        }
        guard matches.count == 1, let cookie = matches.first else {
            clearCredentials()
            throw NativeCallError("앱에서 로그인한 뒤 다시 전화해 주세요.", status: 401)
        }
        if credential?.cookie == cookie.value, (credential?.expiresAt ?? .distantPast) > Date() { return }
        let previous = credential
        if previous != nil { cancel(); onCredentialsChanged?() }
        let version = generation
        let value: NativeSession = try await request("/api/session", cookie: cookie.value, generation: version)
        guard sync == syncGeneration, generation == version else { throw CancellationError() }
        guard let user = value.user, let csrfToken = value.csrfToken, !csrfToken.isEmpty else {
            clearCredentials()
            throw NativeCallError("로그인이 만료됐어요. 앱에서 다시 로그인해 주세요.", status: 401)
        }
        let newCredential = NativeCredential(cookie: cookie.value, userID: user.id,
            expiresAt: cookie.expiresDate ?? Date().addingTimeInterval(86400))
        try saveCredential(newCredential)
        credential = newCredential
        csrf = csrfToken
    }

    func prepare(roomID: String) async throws -> NativeCallContext {
        cancel()
        let version = generation
        let identity = try await authenticate(version: version)
        boundUserID = identity
        let list: NativeRoomList = try await authorized("/api/rooms", version: version)
        guard let room = list.rooms.first(where: { $0.id == roomID && $0.archived != true }),
              roomID != "00000000-0000-4000-8000-000000000001", let bot = list.bots.first else {
            throw NativeCallError("이 대화에 연결할 수 없어요. 앱에서 대화와 참여 권한을 확인해 주세요.", status: 403)
        }
        let capability: NativeVoiceCapability = try await authorized("/api/voice", version: version)
        guard capability.configured else { throw NativeCallError("음성 인식 연결이 필요해요. 앱에서 Groq 연결을 확인해 주세요.") }
        let detail: NativeRoomDetail = try await authorized(roomPath(roomID), version: version)
        guard !detail.busy else { throw NativeCallError("이 대화의 작업이 끝나면 다시 전화해 주세요.") }
        return NativeCallContext(roomID: room.id, title: detail.room.name, userID: identity, botID: bot.id)
    }

    func validate(roomID: String) async throws -> String {
        let version = generation
        _ = try await authenticate(version: version)
        let detail: NativeRoomDetail = try await authorized(roomPath(roomID), version: version)
        return detail.room.name
    }

    func transcribe(_ audio: Data, roomID: String) async throws -> String {
        guard !audio.isEmpty, audio.count <= 10 * 1024 * 1024 else { throw NativeCallError("음성을 짧게 나누어 말씀해 주세요.") }
        let version = generation
        _ = try await authenticate(version: version)
        let boundary = "CloudBot-" + UUID().uuidString
        var body = Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"call.wav\"\r\nContent-Type: audio/wav\r\n\r\n".utf8)
        body.append(audio)
        body.append(Data("\r\n--\(boundary)--\r\n".utf8))
        let result: NativeTranscript = try await authorized(roomPath(roomID) + "/voice/transcribe", method: "POST",
            body: body, contentType: "multipart/form-data; boundary=\(boundary)", timeout: 55, version: version)
        let text = result.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.count <= 4000 else { throw NativeCallError("인식한 내용이 너무 길어요. 짧게 나누어 말씀해 주세요.") }
        return text
    }

    func submit(text: String, roomID: String, nonce: String, model: String, effort: String, botID: String) async throws -> String {
        let version = generation
        _ = try await authenticate(version: version)
        let body = try JSONSerialization.data(withJSONObject: ["text": text, "clientNonce": nonce,
            "botIds": [botID], "model": model, "effort": effort])
        let result: NativeAccepted
        do {
            result = try await authorized(roomPath(roomID) + "/messages", method: "POST", body: body, version: version)
        } catch let error as URLError where [.networkConnectionLost, .notConnectedToInternet, .cannotConnectToHost].contains(error.code) {
            // A single transport retry keeps the SAME nonce and revalidates the actor.
            // Never retry an HTTP rejection, timeout, cancellation, or a changed account.
            _ = try await authenticate(version: version)
            result = try await authorized(roomPath(roomID) + "/messages", method: "POST", body: body, version: version)
        }
        guard let messageID = result.messageId else { throw NativeCallError("요청 접수를 확인하지 못했어요. 대화에서 결과를 확인해 주세요.") }
        return messageID
    }

    func waitReply(roomID: String, messageID: String) async throws -> NativeCallReply {
        let version = generation, deadline = Date().addingTimeInterval(180)
        while Date() < deadline {
            try ensureCurrent(version)
            let detail: NativeRoomDetail = try await authorized(roomPath(roomID), version: version)
            switch NativeCallProtocol.reply(detail, to: messageID) {
            case .reply(let text): return NativeCallReply(title: detail.room.name, text: text)
            case .failure(let message): throw NativeCallError(message)
            case .waiting: try await Task.sleep(nanoseconds: 1_400_000_000)
            }
        }
        throw NativeCallError("답변이 오래 걸리고 있어요. 결과는 이 대화에 남습니다.")
    }

    private func roomPath(_ id: String) throws -> String {
        guard let uuid = UUID(uuidString: id) else { throw NativeCallError("올바른 대화를 선택해 주세요.") }
        return "/api/rooms/" + uuid.uuidString.lowercased()
    }

    private func authenticate(version: Int) async throws -> String {
        try ensureCurrent(version)
        guard let credential, credential.expiresAt > Date() else {
            throw NativeCallError("앱에서 로그인한 뒤 다시 전화해 주세요.", status: 401)
        }
        let value: NativeSession = try await request("/api/session", cookie: credential.cookie, generation: version)
        guard let user = value.user, user.id == credential.userID,
              boundUserID == nil || boundUserID == user.id,
              let token = value.csrfToken, !token.isEmpty else {
            clearCredentials()
            throw NativeCallError("로그인이 바뀌었어요. 다시 로그인한 뒤 전화해 주세요.", status: 401)
        }
        csrf = token
        return user.id
    }

    private func ensureCurrent(_ version: Int) throws {
        try Task.checkCancellation()
        guard generation == version else { throw CancellationError() }
    }

    private func authorized<T: Decodable>(_ path: String, method: String = "GET", body: Data? = nil,
        contentType: String = "application/json", timeout: TimeInterval = 20, version: Int) async throws -> T {
        try ensureCurrent(version)
        guard let credential, credential.expiresAt > Date(), boundUserID == credential.userID else {
            throw NativeCallError("통화 로그인을 다시 확인해 주세요.", status: 401)
        }
        return try await request(path, method: method, body: body, contentType: contentType,
            cookie: credential.cookie, timeout: timeout, generation: version)
    }

    private func request<T: Decodable>(_ path: String, method: String = "GET", body: Data? = nil,
        contentType: String = "application/json", cookie: String, timeout: TimeInterval = 20, generation version: Int) async throws -> T {
        try ensureCurrent(version)
        guard path.hasPrefix("/api/"), let url = URL(string: path, relativeTo: origin)?.absoluteURL,
              CloudBotOrigin.matches(url, configured: origin), NativeCallProtocol.validCookieValue(cookie) else {
            throw NativeCallError("통화 서버 주소를 확인해 주세요.")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method; request.httpBody = body; request.timeoutInterval = timeout
        request.setValue("community_session=" + cookie, forHTTPHeaderField: "Cookie")
        request.setValue(origin.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")), forHTTPHeaderField: "Origin")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if body != nil { request.setValue(contentType, forHTTPHeaderField: "Content-Type"); request.setValue(csrf, forHTTPHeaderField: "X-CSRF-Token") }
        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse else { throw NativeCallError("서버 응답을 확인하지 못했어요.") }
        guard response.expectedContentLength <= 2 * 1024 * 1024 else { bytes.task.cancel(); throw NativeCallError("서버 응답이 너무 큽니다.") }
        var data = Data()
        do {
            for try await byte in bytes {
                if data.count >= 2 * 1024 * 1024 { throw NativeCallError("서버 응답이 너무 큽니다.") }
                data.append(byte)
            }
        } catch { bytes.task.cancel(); throw error }
        try ensureCurrent(version)
        guard (200..<300).contains(http.statusCode) else {
            let message = (try? decoder.decode(NativeAPIError.self, from: data).error) ?? "통화 서버에 연결하지 못했어요."
            throw NativeCallError(String(message.prefix(500)), status: http.statusCode)
        }
        do { return try decoder.decode(T.self, from: data) }
        catch { throw NativeCallError("통화 서버 응답을 읽지 못했어요.") }
    }

    private func keychainQuery() -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: keychainService,
         kSecAttrAccount as String: origin.absoluteString, kSecAttrSynchronizable as String: false]
    }

    private func readCredential() -> NativeCredential? {
        var query = keychainQuery()
        query[kSecReturnData as String] = true; query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data, let value = try? decoder.decode(NativeCredential.self, from: data),
              value.expiresAt > Date(), NativeCallProtocol.validCookieValue(value.cookie) else { return nil }
        return value
    }

    private func saveCredential(_ credential: NativeCredential) throws {
        let data = try JSONEncoder().encode(credential)
        let query = keychainQuery()
        let updates: [String: Any] = [kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let status = SecItemUpdate(query as CFDictionary, updates as CFDictionary)
        if status == errSecItemNotFound {
            guard SecItemAdd(query.merging(updates) { _, new in new } as CFDictionary, nil) == errSecSuccess else {
                throw NativeCallError("아이폰 로그인 저장소에 접근할 수 없어요. 기기를 잠금 해제해 주세요.")
            }
        } else if status != errSecSuccess {
            throw NativeCallError("아이폰 로그인 저장소를 갱신하지 못했어요. 기기를 잠금 해제해 주세요.")
        }
    }
}
