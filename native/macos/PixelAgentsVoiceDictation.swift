import AVFoundation
import Foundation
import Speech

struct StreamEvent: Encodable {
    let type: String
    let text: String?
    let message: String?
}

final class EventStream {
    private let encoder = JSONEncoder()

    func emit(type: String, text: String? = nil, message: String? = nil) {
        let event = StreamEvent(type: type, text: text, message: message)
        guard let data = try? encoder.encode(event), let line = String(data: data, encoding: .utf8) else {
            fputs("{\"type\":\"error\",\"message\":\"Failed to encode event\"}\n", stdout)
            fflush(stdout)
            return
        }

        fputs("\(line)\n", stdout)
        fflush(stdout)
    }
}

@MainActor
final class DictationController {
    private let eventStream = EventStream()
    private let audioEngine = AVAudioEngine()
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var speechRecognizer: SFSpeechRecognizer?
    private var signalSources: [DispatchSourceSignal] = []
    private var isStopping = false

    func run() {
        installSignalHandlers()
        eventStream.emit(type: "ready")
        requestPermissionsAndStart()
        RunLoop.main.run()
    }

    private func installSignalHandlers() {
        signal(SIGINT, SIG_IGN)
        signal(SIGTERM, SIG_IGN)

        for sig in [SIGINT, SIGTERM] {
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            source.setEventHandler { [weak self] in
                self?.stopAndExit(code: 0)
            }
            source.resume()
            signalSources.append(source)
        }
    }

    private func requestPermissionsAndStart() {
        requestMicrophonePermission { [weak self] granted in
            guard let self else { return }
            guard granted else {
                self.eventStream.emit(type: "error", message: "Microphone permission denied")
                self.stopAndExit(code: 1)
                return
            }

            self.requestSpeechPermission { [weak self] authorized in
                guard let self else { return }
                guard authorized else {
                    self.eventStream.emit(type: "error", message: "Speech recognition permission denied")
                    self.stopAndExit(code: 1)
                    return
                }

                self.startRecognitionSession()
            }
        }
    }

    private func requestMicrophonePermission(_ completion: @escaping (Bool) -> Void) {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            completion(true)
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .audio) { granted in
                DispatchQueue.main.async {
                    completion(granted)
                }
            }
        case .denied, .restricted:
            completion(false)
        @unknown default:
            completion(false)
        }
    }

    private func requestSpeechPermission(_ completion: @escaping (Bool) -> Void) {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized:
            completion(true)
        case .notDetermined:
            SFSpeechRecognizer.requestAuthorization { status in
                DispatchQueue.main.async {
                    completion(status == .authorized)
                }
            }
        case .denied, .restricted:
            completion(false)
        @unknown default:
            completion(false)
        }
    }

    private func startRecognitionSession() {
        guard !isStopping else { return }

        guard let recognizer = speechRecognizer ?? SFSpeechRecognizer(locale: Locale.current) else {
            eventStream.emit(type: "error", message: "Speech recognizer unavailable for this language")
            stopAndExit(code: 1)
            return
        }

        speechRecognizer = recognizer

        guard recognizer.isAvailable else {
            eventStream.emit(type: "error", message: "Speech recognizer is currently unavailable")
            stopAndExit(code: 1)
            return
        }

        finishRecognitionSession()

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = false
        recognitionRequest = request

        let inputNode = audioEngine.inputNode
        let inputFormat = inputNode.outputFormat(forBus: 0)
        inputNode.removeTap(onBus: 0)
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: inputFormat) { [weak self] buffer, _ in
            self?.recognitionRequest?.append(buffer)
        }

        audioEngine.prepare()

        do {
            try audioEngine.start()
        } catch {
            eventStream.emit(type: "error", message: "Failed to start audio engine: \(error.localizedDescription)")
            stopAndExit(code: 1)
            return
        }

        eventStream.emit(type: "listening")

        recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self else { return }

            if let result, result.isFinal {
                let transcript = result.bestTranscription.formattedString
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                if !transcript.isEmpty {
                    self.eventStream.emit(type: "text", text: transcript)
                }
                self.restartRecognitionSession()
                return
            }

            if let error {
                self.eventStream.emit(type: "error", message: error.localizedDescription)
                self.stopAndExit(code: 1)
            }
        }
    }

    private func restartRecognitionSession() {
        guard !isStopping else { return }
        finishRecognitionSession()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
            self?.startRecognitionSession()
        }
    }

    private func finishRecognitionSession() {
        recognitionTask?.cancel()
        recognitionTask = nil
        recognitionRequest?.endAudio()
        recognitionRequest = nil

        if audioEngine.isRunning {
            audioEngine.stop()
        }

        audioEngine.inputNode.removeTap(onBus: 0)
    }

    private func stopAndExit(code: Int32) {
        guard !isStopping else { return }
        isStopping = true
        finishRecognitionSession()
        eventStream.emit(type: "stopped")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
            exit(code)
        }
    }
}

@main
struct PixelAgentsVoiceDictationApp {
    static func main() {
        Task { @MainActor in
            let controller = DictationController()
            controller.run()
        }
        dispatchMain()
    }
}
