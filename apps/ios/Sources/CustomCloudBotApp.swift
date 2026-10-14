import SwiftUI
import UIKit
import Intents
import WebKit

@main
@MainActor
struct CustomCloudBotApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var calls = SessionCallCoordinator.shared

    var body: some Scene {
        WindowGroup {
            Group {
                if calls.origin != nil {
                    BrowserView(coordinator: calls)
                        .ignoresSafeArea(.container, edges: .bottom)
                } else {
                    VStack(spacing: 16) {
                        Image(systemName: "cloud.fill").font(.system(size: 48))
                        Text("CustomCloudBot").font(.title)
                        Text("앱 설정의 CLOUDBOT_ORIGIN에 서버의 HTTPS 주소를 지정해 주세요.")
                            .multilineTextAlignment(.center)
                    }.padding(32)
                }
            }
            .onOpenURL { calls.open(deepLink: $0) }
            .onContinueUserActivity("INStartCallIntent") { calls.resume(activity: $0) }
            .onContinueUserActivity("INStartAudioCallIntent") { calls.resume(activity: $0) }
            .sheet(isPresented: $calls.showingCallControls) {
                NativeCallView(calls: calls)
                    .presentationDetents([.medium, .large])
            }
            .alert("통화 안내", isPresented: Binding(
                get: { calls.errorMessage != nil },
                set: { if !$0 { calls.errorMessage = nil } })) {
                    Button("확인", role: .cancel) { calls.errorMessage = nil }
                } message: { Text(calls.errorMessage ?? "") }
        }
    }
}

@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, continue userActivity: NSUserActivity,
                     restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        SessionCallCoordinator.shared.resume(activity: userActivity)
    }
}

@MainActor
struct BrowserView: UIViewRepresentable {
    let coordinator: SessionCallCoordinator
    func makeUIView(context: Context) -> WKWebView { coordinator.webView }
    func updateUIView(_ view: WKWebView, context: Context) {}
}

/// Recents can reconnect before WebKit has loaded. These controls remain native too.
@MainActor
private struct NativeCallView: View {
    @ObservedObject var calls: SessionCallCoordinator

    private var stateLabel: String {
        switch calls.callState {
        case "connecting": return "통화를 연결하고 있어요"
        case "listening": return "듣고 있어요"
        case "muted": return "마이크가 꺼져 있어요"
        case "processing", "transcribing": return "말씀을 확인하고 있어요"
        case "waiting": return "답변을 기다리고 있어요"
        case "speaking": return "답변을 들려드리고 있어요"
        case "paused": return "다른 통화가 끝나면 이어집니다"
        case "error": return "통화가 중단됐어요"
        default: return "통화가 끝났어요"
        }
    }

    var body: some View {
        VStack(spacing: 22) {
            Image(systemName: "phone.fill").font(.system(size: 32)).foregroundStyle(.purple)
            Text(calls.callTitle.isEmpty ? "대화에 전화하기" : calls.callTitle)
                .font(.title2.bold()).multilineTextAlignment(.center)
            Text(stateLabel).foregroundStyle(.secondary)
            if !calls.callText.isEmpty {
                Text(calls.callText).font(.callout).lineLimit(4).multilineTextAlignment(.center)
            }
            if calls.isCalling {
                HStack(spacing: 28) {
                    Button { calls.toggleMuted() } label: {
                        Label(calls.isMuted ? "마이크 켜기" : "마이크 끄기",
                              systemImage: calls.isMuted ? "mic.slash.fill" : "mic.fill")
                    }
                    .disabled(calls.callState == "connecting")
                    Button { calls.finishUtterance() } label: { Label("말 끝내기", systemImage: "checkmark") }
                        .disabled(calls.callState != "listening")
                }.buttonStyle(.bordered)
                Button(role: .destructive) { calls.endCall() } label: {
                    Label("통화 종료", systemImage: "phone.down.fill").frame(maxWidth: .infinity)
                }.buttonStyle(.borderedProminent).tint(.red)
            } else {
                Button("닫기") { calls.showingCallControls = false }.buttonStyle(.bordered)
            }
        }.padding(28)
    }
}
