import Foundation
import AVFoundation

/// Audio belongs to the native CallKit call, never to WKWebView. The coordinator
/// starts this object only in CXProviderDelegate.didActivate and stops it when
/// CallKit deactivates the session. It never activates/deactivates AVAudioSession.
@MainActor
final class NativeVoiceAudio: NSObject {
    var onUtterance: ((Data) -> Void)?
    var onState: ((String) -> Void)?
    var onFailure: ((String) -> Void)?

    private var engine: AVAudioEngine?
    private var capture: NativeVoiceCapture?
    private var configurationObserver: NSObjectProtocol?
    private let synthesizer = AVSpeechSynthesizer()
    private var speechContinuation: CheckedContinuation<Void, Never>?
    private var speechID: UUID?
    private var speechUtterance: AVSpeechUtterance?
    private var active = false
    private var muted = false
    private var acceptingSpeech = true
    private var generation = UUID()

    override init() {
        super.init()
        synthesizer.delegate = self
        // Speech uses the already-active CallKit session, including Bluetooth routes.
        #if os(iOS)
        synthesizer.usesApplicationAudioSession = true
        #endif
    }

    /// Requires the system-owned playAndRecord/voiceChat session to be active.
    func start() throws {
        guard !active else { return }
        acceptingSpeech = true
        active = true
        do {
            try installEngine()
            publishListeningState()
        } catch {
            active = false
            tearDownEngine()
            throw error
        }
    }

    func stop() {
        active = false
        acceptingSpeech = false
        generation = UUID()
        tearDownEngine()
        cancelSpeech()
        onState?("stopped")
    }

    /// An input route can change its channel count or sample rate. Discard the
    /// unfinished phrase instead of combining incompatible PCM in one WAV file.
    func restartForRouteChange() throws {
        guard active else { return }
        tearDownEngine()
        do { try installEngine() }
        catch {
            active = false
            cancelSpeech()
            throw error
        }
        if speechID != nil { onState?("speaking") }
        else if acceptingSpeech { publishListeningState() }
    }

    func setMuted(_ value: Bool) {
        muted = value
        capture?.setEnabled(active && acceptingSpeech && speechID == nil && !muted)
        if active, speechID == nil, acceptingSpeech { publishListeningState() }
    }

    /// A user may submit a phrase without waiting for the silence gate.
    func finishUtterance() {
        guard active, acceptingSpeech, !muted, speechID == nil,
              let packet = capture?.finish() else { return }
        receive(packet.audio, generation: generation, captureRevision: packet.revision)
    }

    /// The engine remains running while networking and native TTS are in progress.
    /// Buffers are discarded during those stages; they are never uploaded/stored.
    func speak(_ text: String) async {
        guard active, !Task.isCancelled else { return }
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        cancelSpeech()
        acceptingSpeech = false
        capture?.setEnabled(false)
        let id = UUID()
        let utterance = AVSpeechUtterance(string: String(value.prefix(12_000)))
        utterance.voice = AVSpeechSynthesisVoice(language: "ko-KR")
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate
        speechID = id
        speechUtterance = utterance
        onState?("speaking")
        await withTaskCancellationHandler(operation: {
            await withCheckedContinuation { continuation in
                guard active, !Task.isCancelled, speechID == id else {
                    continuation.resume()
                    return
                }
                speechContinuation = continuation
                synthesizer.speak(utterance)
            }
        }, onCancel: { [weak self] in
            Task { @MainActor in
                guard let self, self.speechID == id else { return }
                self.cancelSpeech()
            }
        })
    }

    func pauseListening() {
        guard active else { return }
        acceptingSpeech = false
        capture?.setEnabled(false)
        if speechID == nil { onState?("processing") }
    }

    func resumeListening() {
        guard active, speechID == nil else { return }
        acceptingSpeech = true
        capture?.setEnabled(!muted)
        publishListeningState()
    }

    private func installEngine() throws {
        let newEngine = AVAudioEngine()
        let input = newEngine.inputNode
        let native = input.outputFormat(forBus: 0)
        guard native.channelCount > 0, native.sampleRate >= 8_000, native.sampleRate <= 192_000,
              let format = AVAudioFormat(standardFormatWithSampleRate: native.sampleRate,
                                         channels: native.channelCount) else {
            throw AudioError.noInput
        }
        let id = UUID()
        generation = id
        let sink = NativeVoiceCapture(sampleRate: Int(format.sampleRate.rounded())) { [weak self] audio, revision in
            Task { @MainActor in self?.receive(audio, generation: id, captureRevision: revision) }
        }
        sink.setEnabled(acceptingSpeech && speechID == nil && !muted)
        input.installTap(onBus: 0, bufferSize: 1_024, format: format) { buffer, _ in
            sink.consume(buffer)
        }
        capture = sink
        engine = newEngine
        let engineIdentity = ObjectIdentifier(newEngine)
        configurationObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: newEngine, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                // Give an interruption/deactivation event time to stop the call's
                // audio before attempting a hardware-route rebuild.
                try? await Task.sleep(nanoseconds: 150_000_000)
                guard let self, let changed = self.engine, self.active, self.generation == id,
                      ObjectIdentifier(changed) == engineIdentity, !changed.isRunning else { return }
                // Hardware changes may stop the engine before a route notification.
                // The identity check prevents an old engine's reset from restarting it.
                do { try self.restartForRouteChange() }
                catch { self.onFailure?("오디오 기기가 바뀌어 마이크를 다시 열 수 없습니다. 통화를 다시 시작해 주세요.") }
            }
        }
        newEngine.prepare()
        do { try newEngine.start() }
        catch { tearDownEngine(); throw error }
    }

    private func tearDownEngine() {
        if let configurationObserver {
            NotificationCenter.default.removeObserver(configurationObserver)
            self.configurationObserver = nil
        }
        capture?.setEnabled(false)
        if let engine {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
            engine.reset()
        }
        capture = nil
        engine = nil
        generation = UUID()
    }

    private func receive(_ audio: Data, generation id: UUID, captureRevision: UUID) {
        guard active, generation == id, acceptingSpeech, !muted, speechID == nil,
              capture?.isCurrent(captureRevision) == true else { return }
        acceptingSpeech = false
        capture?.setEnabled(false)
        onState?("processing")
        onUtterance?(audio)
    }

    private func publishListeningState() { onState?(muted ? "muted" : "listening") }

    private func cancelSpeech() {
        // Clear identity before stopSpeaking, which may invoke didCancel immediately.
        speechID = nil
        speechUtterance = nil
        let continuation = speechContinuation
        speechContinuation = nil
        synthesizer.stopSpeaking(at: .immediate)
        continuation?.resume()
    }

    private func speechFinished(_ utterance: AVSpeechUtterance) {
        guard speechUtterance === utterance else { return }
        speechID = nil
        speechUtterance = nil
        let continuation = speechContinuation
        speechContinuation = nil
        continuation?.resume()
        // The coordinator resumes only once its turn/activation still matches.
    }

    private enum AudioError: LocalizedError {
        case noInput
        var errorDescription: String? { "마이크 오디오 경로를 열 수 없습니다. 연결된 오디오 기기를 확인해 주세요." }
    }
}

extension NativeVoiceAudio: AVSpeechSynthesizerDelegate {
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor [weak self] in self?.speechFinished(utterance) }
    }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        Task { @MainActor [weak self] in self?.speechFinished(utterance) }
    }
}

/// The input tap runs on an audio thread. State and the bounded accumulator are
/// synchronized here; no actor-isolated/UI state is touched by the render callback.
private final class NativeVoiceCapture {
    private let lock = NSLock()
    private var enabled = false
    private var revision = UUID()
    private var utterance: VoiceUtterance
    private let complete: (Data, UUID) -> Void

    init(sampleRate: Int, complete: @escaping (Data, UUID) -> Void) {
        utterance = VoiceUtterance(sampleRate: sampleRate)
        self.complete = complete
    }

    func setEnabled(_ value: Bool) {
        lock.lock()
        enabled = value
        revision = UUID()
        utterance.reset()
        lock.unlock()
    }

    func isCurrent(_ value: UUID) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return revision == value
    }

    func finish() -> (audio: Data, revision: UUID)? {
        lock.lock()
        defer { lock.unlock() }
        guard enabled else { return nil }
        let audio = utterance.finish()
        guard let audio else { return nil }
        enabled = false
        return (audio, revision)
    }

    func consume(_ buffer: AVAudioPCMBuffer) {
        lock.lock()
        guard enabled, let channels = buffer.floatChannelData, buffer.frameLength > 0 else {
            lock.unlock()
            return
        }
        let count = Int(buffer.frameLength)
        let channelCount = Int(buffer.format.channelCount)
        guard channelCount > 0 else { lock.unlock(); return }
        let interleaved = buffer.format.isInterleaved
        var mono = [Float](repeating: 0, count: count)
        for frame in 0..<count {
            var value: Float = 0
            for channel in 0..<channelCount {
                value += interleaved ? channels[0][frame * channelCount + channel] : channels[channel][frame]
            }
            mono[frame] = value / Float(channelCount)
        }
        let audio = utterance.append(mono)
        if audio != nil { enabled = false }
        let completedRevision = revision
        lock.unlock()
        if let audio { complete(audio, completedRevision) }
    }
}
