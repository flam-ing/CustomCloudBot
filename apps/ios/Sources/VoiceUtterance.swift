import Foundation

/// A bounded, mono PCM utterance with a short leading buffer and a silence gate.
/// Sample rate follows the input route; the WAV header describes the real rate.
struct VoiceUtterance {
    let sampleRate: Int
    private let maximumFrames: Int
    private let minimumVoiceFrames: Int
    private let silenceFrames: Int
    private let preRollFrames: Int
    private let threshold: Float
    private var preRoll: [Int16] = []
    private var samples: [Int16] = []
    private var voiceFrames = 0
    private var quietFrames = 0
    private var recording = false

    init(sampleRate: Int, maximumDuration: Double = 30, silenceDuration: Double = 0.85,
         minimumVoiceDuration: Double = 0.16, preRollDuration: Double = 0.25,
         threshold: Float = 0.012) {
        precondition((8_000...192_000).contains(sampleRate))
        self.sampleRate = sampleRate
        // Header + signed 16-bit mono frames must stay below the upload limit.
        maximumFrames = max(1, min(Int(Double(sampleRate) * min(30, max(0.01, maximumDuration))),
                                  (10_000_000 - 44) / 2))
        minimumVoiceFrames = max(1, Int(Double(sampleRate) * max(0, minimumVoiceDuration)))
        silenceFrames = max(1, Int(Double(sampleRate) * max(0.01, silenceDuration)))
        preRollFrames = max(0, min(Int(Double(sampleRate) * max(0, preRollDuration)), maximumFrames))
        self.threshold = max(0.001, threshold)
    }

    mutating func reset() {
        preRoll.removeAll(keepingCapacity: true)
        samples.removeAll(keepingCapacity: true)
        voiceFrames = 0
        quietFrames = 0
        recording = false
    }

    mutating func append(_ input: [Float]) -> Data? {
        guard !input.isEmpty else { return nil }
        var energy: Double = 0
        let pcm = input.map { raw -> Int16 in
            let value = raw.isFinite ? min(1, max(-1, raw)) : 0
            energy += Double(value * value)
            return Int16((value * 32_767).rounded())
        }
        let voiced = sqrt(energy / Double(input.count)) >= Double(threshold)
        if !recording {
            guard voiced else {
                if preRollFrames > 0 {
                    preRoll.append(contentsOf: pcm.suffix(preRollFrames))
                    if preRoll.count > preRollFrames { preRoll.removeFirst(preRoll.count - preRollFrames) }
                }
                return nil
            }
            recording = true
            samples = preRoll
            preRoll.removeAll(keepingCapacity: true)
        }
        let remaining = max(0, maximumFrames - samples.count)
        samples.append(contentsOf: pcm.prefix(remaining))
        if voiced {
            voiceFrames += min(pcm.count, remaining)
            quietFrames = 0
        } else {
            quietFrames += pcm.count
        }
        if samples.count >= maximumFrames || quietFrames >= silenceFrames { return finish() }
        return nil
    }

    mutating func finish() -> Data? {
        defer { reset() }
        guard recording, voiceFrames >= minimumVoiceFrames, !samples.isEmpty else { return nil }
        return Self.wav(samples: samples, sampleRate: sampleRate)
    }

    private static func wav(samples: [Int16], sampleRate: Int) -> Data {
        var result = Data(capacity: 44 + samples.count * 2)
        func text(_ value: String) { result.append(contentsOf: value.utf8) }
        func uint16(_ value: UInt16) {
            result.append(UInt8(truncatingIfNeeded: value))
            result.append(UInt8(truncatingIfNeeded: value >> 8))
        }
        func uint32(_ value: UInt32) {
            for shift in stride(from: 0, through: 24, by: 8) {
                result.append(UInt8(truncatingIfNeeded: value >> shift))
            }
        }
        text("RIFF"); uint32(UInt32(36 + samples.count * 2)); text("WAVE")
        text("fmt "); uint32(16); uint16(1); uint16(1)
        uint32(UInt32(sampleRate)); uint32(UInt32(sampleRate * 2)); uint16(2); uint16(16)
        text("data"); uint32(UInt32(samples.count * 2))
        let littleEndianSamples = samples.map { $0.littleEndian }
        littleEndianSamples.withUnsafeBytes { result.append(contentsOf: $0) }
        return result
    }
}
