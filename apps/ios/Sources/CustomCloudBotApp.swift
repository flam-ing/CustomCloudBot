import SwiftUI
import UIKit
import Intents
import WebKit

@main
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
        }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, continue userActivity: NSUserActivity,
                     restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        SessionCallCoordinator.shared.resume(activity: userActivity)
    }
}

struct BrowserView: UIViewRepresentable {
    let coordinator: SessionCallCoordinator
    func makeUIView(context: Context) -> WKWebView { coordinator.webView }
    func updateUIView(_ view: WKWebView, context: Context) {}
}
