import Foundation

/// The immutable room identifier is the call address. Titles are display metadata only.
struct SessionCallRoute: Equatable {
    let roomID: UUID

    init?(roomID: String) {
        guard let value = UUID(uuidString: roomID) else { return nil }
        self.roomID = value
    }

    init?(deepLink: URL) {
        guard let parts = URLComponents(url: deepLink, resolvingAgainstBaseURL: false),
              parts.scheme?.lowercased() == "customcloudbot", parts.host == "call",
              parts.user == nil, parts.password == nil, parts.port == nil,
              parts.query == nil, parts.fragment == nil,
              parts.path.split(separator: "/").count == 1,
              !parts.path.hasSuffix("/") else { return nil }
        self.init(roomID: String(parts.path.dropFirst()))
    }

    var handle: String { roomID.uuidString.lowercased() }

    func pageURL(origin: URL) -> URL {
        var parts = URLComponents(url: origin, resolvingAgainstBaseURL: false)!
        parts.path = "/"
        parts.queryItems = [URLQueryItem(name: "room", value: handle), URLQueryItem(name: "call", value: "1")]
        return parts.url!
    }
}

enum CloudBotOrigin {
    /// Use one explicit HTTPS origin. A bridge payload may never replace this value.
    static func parse(_ value: String) -> URL? {
        let text = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let parts = URLComponents(string: text), parts.scheme?.lowercased() == "https",
              let rawHost = parts.host, !rawHost.isEmpty,
              parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/",
              parts.port == nil || (1...65535).contains(parts.port!),
              let url = parts.url else { return nil }
        let host = rawHost.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        guard host != "localhost", !host.hasSuffix(".localhost"),
              host != "::1", host != "0.0.0.0", host != "0", host != "::",
              !host.hasPrefix("127."), host != "2130706433", !host.hasSuffix(".") else { return nil }
        return url
    }

    static func matches(_ url: URL?, configured: URL) -> Bool {
        guard let url, url.scheme?.lowercased() == "https",
              url.user == nil, url.password == nil else { return false }
        return url.host?.lowercased() == configured.host?.lowercased()
            && (url.port ?? 443) == (configured.port ?? 443)
    }
}
