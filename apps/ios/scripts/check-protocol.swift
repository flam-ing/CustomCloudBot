import Foundation

@main
struct ProtocolChecks {
    static func check(_ condition: @autoclosure () -> Bool, _ message: String) {
        guard condition() else { fatalError(message) }
    }
    static func detail(_ messages: [NativeRoomMessage], busy: Bool = true) -> NativeRoomDetail {
        NativeRoomDetail(room: NativeRoom(id: "11111111-1111-4111-8111-111111111111", name: "프로젝트 통화", archived: false),
                         messages: messages, busy: busy)
    }
    static func message(_ id: String, _ kind: String, _ text: String? = nil) -> NativeRoomMessage {
        NativeRoomMessage(id: id, kind: kind, text: text)
    }
    static func isFailure(_ value: NativeReplyOutcome) -> Bool {
        if case .failure = value { return true }; return false
    }
    static func main() throws {
        let human = message("target", "human", "서버 상태를 알려줘")
        let answer = message("answer", "bot", "  정상입니다. \n")
        check(NativeCallProtocol.reply(detail([]), to: "target") == .waiting, "Absent target must never read unrelated replies")
        check(NativeCallProtocol.reply(detail([message("old", "bot", "Old reply"), human]), to: "target") == .waiting,
              "Earlier bot messages must not be replayed")
        check(NativeCallProtocol.reply(detail([message("target", "bot", "Forged target"), answer]), to: "target") == .waiting,
              "Target ID must match a human message")
        check(NativeCallProtocol.reply(detail([human, answer]), to: "target") == .reply("정상입니다."),
              "The accepted human's next bot reply is spoken")
        check(isFailure(NativeCallProtocol.reply(detail([human, message("other", "human", "Other task"), answer]), to: "target")),
              "Another human request must end correlation before its reply")
        check(NativeCallProtocol.reply(detail([human, answer, message("later", "human", "Later task")]), to: "target") == .reply("정상입니다."),
              "A completed answer before another turn remains correlated")
        check(NativeCallProtocol.reply(detail([human, message("empty", "bot", "\n ")]), to: "target") == .waiting,
              "Blank bot output cannot complete a turn")
        check(NativeCallProtocol.reply(detail([human, message("failure", "system", "모델 연결 오류")]), to: "target") == .failure("모델 연결 오류"),
              "Server failure must not be presented as a successful reply")
        check(isFailure(NativeCallProtocol.reply(detail([human], busy: false), to: "target")),
              "An idle room with no answer must end the pending call turn")
        check(NativeCallProtocol.reply(detail([human, message("empty", "system", ""), answer]), to: "target") == .reply("정상입니다."),
              "Empty system metadata may precede an answer")

        check(NativeCallProtocol.validCookieValue("abcDEF_123-456"), "Base64url session token accepted")
        for bad in ["", "abc; session=other", "abc\r\nCookie: injected", "abc\n", "abc\r\n", "abc def", "abc=", String(repeating: "x", count: 101)] {
            check(!NativeCallProtocol.validCookieValue(bad), "Unsafe or overlong cookie must be rejected")
        }
        let speech = NativeCallProtocol.speechText("## 결과\n[문서](https://example.com/private) 확인.\n```sh\nsudo unsafe-command\n```\n![사진](https://example.com/a.png) https://example.com/raw")
        check(speech.contains("결과") && speech.contains("문서") && speech.contains("코드 내용은 대화에 남겨두었어요."),
              "Speech keeps the explanation while referring to saved code")
        check(!speech.contains("unsafe-command") && !speech.contains("https://") && !speech.contains("!["),
              "Code, raw URLs, and Markdown images must not be read aloud")
        let long = NativeCallProtocol.speechText(String(repeating: "가", count: 1400))
        check(long.hasPrefix(String(repeating: "가", count: 1200)) && long.hasSuffix("나머지는 대화에서 확인해 주세요."),
              "Long answers are bounded without cutting Unicode characters")
        let fixture = Data(#"{"room":{"id":"room","name":"제목"},"messages":[{"id":"m","kind":"human","authorId":"user","attachments":[]}],"busy":true,"progress":[]}"#.utf8)
        let decoded = try JSONDecoder().decode(NativeRoomDetail.self, from: fixture)
        check(decoded.busy && decoded.messages[0].text == nil && decoded.room.archived == nil,
              "Native room decoder accepts the server's optional message fields")
        print("Native call protocol: correlation boundaries, failures, cookie validation, speech text, response decoding checks passed.")
    }
}
