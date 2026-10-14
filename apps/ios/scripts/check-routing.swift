import Foundation

@main
struct RoutingChecks {
    static func main() {
        let id = "123e4567-e89b-12d3-a456-426614174000"
        let origin = CloudBotOrigin.parse("https://example.com")!
        let route = SessionCallRoute(roomID: id)!
        precondition(route.handle == id)
        precondition(SessionCallRoute(roomID: "../../etc/passwd") == nil)
        precondition(SessionCallRoute(roomID: "not-a-session") == nil)
        precondition(SessionCallRoute(deepLink: URL(string: "customcloudbot://call/\(id)")!) == route)
        for path in [
            "customcloudbot://call/\(id)?origin=https://attacker.example",
            "customcloudbot://call/\(id)#other", "customcloudbot://call/\(id)/",
            "customcloudbot://call/\(id)/other", "customcloudbot://user@call/\(id)",
            "customcloudbot://call:443/\(id)", "https://call/\(id)",
            "customcloudbot://other/\(id)", "customcloudbot://call/not-a-session"
        ] {
            precondition(SessionCallRoute(deepLink: URL(string: path)!) == nil, path)
        }
        for value in [
            "", "$(CLOUDBOT_ORIGIN)", "http://example.com", "https://localhost",
            "https://my.localhost", "https://127.0.0.1", "https://[::1]", "https://0.0.0.0",
            "https://example.com/other", "https://user:pass@example.com", "https://example.com?x=1",
            "https://example.com#other", "https://example.com:0", "https://example.com:65536",
            "https://example.com."
        ] {
            precondition(CloudBotOrigin.parse(value) == nil, value)
        }
        precondition(CloudBotOrigin.parse(" https://example.com/ ") != nil)
        precondition(CloudBotOrigin.parse("https://example.com:8443") != nil)
        precondition(CloudBotOrigin.matches(URL(string: "https://EXAMPLE.com:443/path"), configured: origin))
        precondition(!CloudBotOrigin.matches(URL(string: "https://example.com.attacker.org"), configured: origin))
        precondition(!CloudBotOrigin.matches(URL(string: "https://example.com:8443"), configured: origin))
        precondition(!CloudBotOrigin.matches(URL(string: "http://example.com"), configured: origin))
        precondition(!CloudBotOrigin.matches(URL(string: "https://user@example.com"), configured: origin))
        let page = URLComponents(url: route.pageURL(origin: origin), resolvingAgainstBaseURL: false)!
        precondition(page.host == "example.com" && page.path == "/")
        precondition(page.queryItems == [URLQueryItem(name: "room", value: id), URLQueryItem(name: "call", value: "1")])
        print("Native call routing checks passed (room identity, deep links, configured origin).")
    }
}
