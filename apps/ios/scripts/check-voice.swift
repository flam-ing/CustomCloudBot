import Foundation

@main
struct VoiceChecks {
    static func check(_ condition: @autoclosure () -> Bool, _ message: String) {
        guard condition() else { fatalError(message) }
    }
    static func value32(_ data: Data, _ offset: Int) -> Int {
        (0..<4).reduce(0) { $0 | (Int(data[offset + $1]) << (8 * $1)) }
    }
    static func main() {
        let sampleRate = 16_000
        let voice = [Float](repeating: 0.2, count: 1_600)
        let quiet = [Float](repeating: 0, count: 1_600)
        var phrase = VoiceUtterance(sampleRate: sampleRate)
        for _ in 0..<20 { check(phrase.append(quiet) == nil, "Silence must not create an utterance") }
        check(phrase.append(voice) == nil, "First voice block must accumulate")
        check(phrase.append(voice) == nil, "Voice must wait for end of phrase")
        var result: Data?
        for _ in 0..<9 { if let wav = phrase.append(quiet) { result = wav } }
        guard let wav = result else { fatalError("A voiced phrase must finish after silence") }
        check(String(data: wav.prefix(4), encoding: .ascii) == "RIFF", "WAV RIFF magic")
        check(String(data: wav[8..<12], encoding: .ascii) == "WAVE", "WAV format")
        check(value32(wav, 24) == sampleRate, "Header must describe actual input rate")
        check(value32(wav, 28) == sampleRate * 2, "Mono PCM16 byte rate")
        check(wav[22] == 1 && wav[34] == 16, "One channel of 16-bit samples")
        check(value32(wav, 40) == wav.count - 44, "WAV data size")
        check(value32(wav, 4) == wav.count - 8, "RIFF payload size")
        check(phrase.finish() == nil, "Finished phrase cannot be sent twice")

        var click = VoiceUtterance(sampleRate: sampleRate)
        _ = click.append([Float](repeating: 0.9, count: 50))
        for _ in 0..<10 { check(click.append(quiet) == nil, "Short clicks must not create requests") }

        var manual = VoiceUtterance(sampleRate: 48_000)
        _ = manual.append([Float](repeating: 0.1, count: 10_000))
        guard let manualWav = manual.finish() else { fatalError("Manual finish must preserve recorded speech") }
        check(value32(manualWav, 24) == 48_000, "Route sample rates are not relabelled")
        _ = manual.append([Float](repeating: 0.1, count: 10_000))
        manual.reset()
        check(manual.finish() == nil, "Mute/interrupt resets discard partial audio")

        var bounded = VoiceUtterance(sampleRate: 192_000)
        var boundedWav: Data?
        for _ in 0..<31 {
            if let output = bounded.append([Float](repeating: 0.2, count: 192_000)) {
                boundedWav = output
                break
            }
        }
        guard let boundedWav else { fatalError("Continuous speech must end at maximum duration/bytes") }
        check(boundedWav.count <= 10 * 1_024 * 1_024, "WAV must stay within 10 MiB limit")
        check(value32(boundedWav, 40) / 2 <= 192_000 * 30, "PCM must stay within 30 seconds")

        var invalid = VoiceUtterance(sampleRate: sampleRate)
        _ = invalid.append([Float](repeating: .nan, count: 1_600))
        _ = invalid.append([Float](repeating: .infinity, count: 1_600))
        check(invalid.finish() == nil, "Non-finite audio cannot trigger speech or crash conversion")
        print("Native voice: silence, speech boundaries, PCM WAV, manual finish, reset, size/duration, invalid sample checks passed.")
    }
}
