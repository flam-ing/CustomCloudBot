import Foundation

struct NativeCallContext {
    let roomID: String
    let title: String
    let userID: String
    let botID: String
}

struct NativeCallReply {
    let title: String
    let text: String
}

struct NativeRoom: Decodable {
    let id: String
    let name: String
    let archived: Bool?
}

struct NativeRoomMessage: Decodable {
    let id: String
    let kind: String
    let text: String?
}

struct NativeRoomDetail: Decodable {
    let room: NativeRoom
    let messages: [NativeRoomMessage]
    let busy: Bool
}

enum NativeReplyOutcome: Equatable {
    case waiting
    case reply(String)
    case failure(String)
}

enum NativeCallProtocol {
    static func reply(_ room: NativeRoomDetail, to messageID: String) -> NativeReplyOutcome {
        guard let index = room.messages.firstIndex(where: { $0.id == messageID && $0.kind == "human" }) else { return .waiting }
        for message in room.messages.dropFirst(index + 1) {
            if message.kind == "human" { return .failure("다른 메시지가 이어졌어요. 답변은 이 대화에서 확인해 주세요.") }
            let text = (message.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if message.kind == "bot", !text.isEmpty { return .reply(text) }
            if message.kind == "system", !text.isEmpty { return .failure(text) }
        }
        return room.busy ? .waiting : .failure("답변을 받지 못했어요. 대화에서 결과를 확인해 주세요.")
    }

    static func speechText(_ input: String) -> String {
        var value = input
        for (pattern, replacement) in [
            ("```[\\s\\S]*?```", " 코드 내용은 대화에 남겨두었어요. "),
            ("!\\[[^\\]]*\\]\\([^)]*\\)", ""),
            ("\\[([^\\]]+)\\]\\([^)]*\\)", "$1"),
            ("https?://\\S+", "링크"),
            ("[#*_`>|]", " "),
            ("\\s+", " ")
        ] {
            value = value.replacingOccurrences(of: pattern, with: replacement, options: .regularExpression)
        }
        value = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.count > 1200 ? String(value.prefix(1200)) + " 나머지는 대화에서 확인해 주세요." : value
    }

    static func validCookieValue(_ value: String) -> Bool {
        !value.isEmpty && value.count <= 100 && value.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil
    }
}

struct NativeCallError: LocalizedError {
    let message: String
    let status: Int?
    init(_ message: String, status: Int? = nil) { self.message = message; self.status = status }
    var errorDescription: String? { message }
}
