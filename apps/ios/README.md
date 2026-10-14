# CustomCloudBot iOS calling shell

This is a native iOS shell for the existing CustomCloudBot website. It adds CallKit
call identity and system controls around the site's **foreground voice conversation**.
It is not an installed app, an incoming-call service, or proof of reliable locked-screen
calling. A PWA by itself cannot use this native bridge.

Each call uses an immutable chat room UUID as its generic CallKit handle and the chat
title as `localizedCallerName`. Renaming a chat does not change its address. The title
is shown in system call UI and updated when the website receives a new generated or
edited title; calls are included in Phone Recents. Tapping
a supported Recents call opens the same room's call sheet, after normal authentication.
It does not make a new chat or silently start the microphone. The website remains
responsible for checking current membership and for rejecting deleted/inaccessible rooms.

## Build and install

Requirements are full Xcode with an iPhoneOS SDK, XcodeGen, an Apple signing team,
and a physical iPhone for system call/audio verification. No signing identity, account,
server URL, certificate, or API key is included in this directory.

1. Run `xcodegen generate` in this directory to generate `CustomCloudBot.xcodeproj`.
2. Open that project in Xcode. Select your signing team and change
   `PRODUCT_BUNDLE_IDENTIFIER` from the example to your own identifier.
3. Set the `CLOUDBOT_ORIGIN` build setting to your server's HTTPS origin, for example
   `https://bot.example.org`. Use no path, credentials, query, or fragment. It starts
   blank, so an unconfigured app shows a setup message. HTTP/localhost are rejected.
4. Select your connected iPhone and Build/Run. Grant microphone access when requested.
5. Sign in within the app and press the room's phone button. The WKWebView uses its
   persistent cookie store. Tokens and API keys are never placed in call URLs.

Generated project/Info.plist and private `*.local.xcconfig` files are ignored. App Store
or TestFlight distribution and APNs credentials require separate account setup; this
source does not purchase or provision any Apple service.

## Web bridge

Only the main frame at the configured HTTPS origin can invoke the handler. A message's
`origin` value is ignored. Cross-origin pages cannot acquire this native call authority;
external web links open in the system browser.

```js
window.webkit.messageHandlers.cloudbotCall.postMessage({
  action: 'start', roomId, roomTitle
});
```

The page waits for the `cloudbot:native-call` DOM event with
`detail: { action: 'active', roomId }` before requesting microphone capture or starting
audio. CallKit calls `didActivate` to produce this event; the shell does not activate
`AVAudioSession` itself. After microphone/voice initialization succeeds, the page sends
`{action: 'connected', roomId}`. Only then does the shell report a connected call.

The page sends `{action: 'end', roomId}` on hangup and `{action: 'failed', roomId}` on
initialization failure. Native events `ended` and `error` stop microphone, audio, and
pending requests; `error` may include `message`. Native mute controls emit `muted` and
`unmuted` events, which the page applies to its microphone track. All messages target
the anchored call room, even when a different chat is visible.

When the server generates a title after the first voice turn, or the title changes,
the page sends `{action: 'title', roomId, roomTitle}` to refresh the active CallKit
display without changing the call's room UUID.

Custom URL `customcloudbot://call/<room-uuid>` and CallKit's `INStartCallIntent` (plus
the older `INStartAudioCallIntent`) route to `/?room=<room-uuid>&call=1` on the installed
origin. A call link opens the sheet, requiring the user to press Start. The custom URL
never accepts an origin, access token, title, arbitrary path, or command. Universal
links are not enabled: they need a real team/bundle ID and a matching server AASA file.

## Validation and current limits

Run `sh scripts/check.sh` for Foundation-only executable routing checks and Swift
syntax parsing. These checks do **not** compile UIKit/WebKit/CallKit against the iOS
SDK or validate device behavior. At implementation time the development Mac had only
Command Line Tools, no iPhoneOS SDK, and no valid code-signing identity; therefore
native build, installation, Phone Recents display, and real audio remain unverified.

Before treating this as a released native app, verify on a physical iPhone:

- Start two different chat calls and see the correct titles in system UI/Recents.
- Redial each entry and verify it opens that same accessible room; deleted rooms fail.
- Deny the microphone, fail network setup, end from system UI, and receive a cellular
  interruption; verify capture stops and no stuck CallKit call remains.
- Verify Bluetooth/speaker routing, mute/unmute, web navigation, logout, and a renamed
  room. Test refresh/process death and background/lock explicitly.

WKWebView supports microphone capture, but foreground browser audio plus CallKit does
not establish that WebKit speech recognition/playback survives suspension or screen
lock. The current website deliberately ends calls when its document becomes hidden,
including in this shell: this version does not keep a native call running in the
background or when the screen locks. System audio deactivation (for example another
call interrupting this one) ends this call too. Redial opens the same chat and retains
its saved context. Reliable background calling should move capture/playback and the voice transport
to a native audio engine. Incoming ringing while the app is suspended additionally
needs PushKit/APNs and prompt CallKit reporting; neither is implemented here. Phone
numbers and paid PSTN services are not required for this app-to-agent design.

## Apple references

- [CallKit](https://developer.apple.com/documentation/callkit)
- [Outgoing/incoming call lifecycle and audio activation](https://developer.apple.com/documentation/callkit/making-and-receiving-voip-calls)
- [Generic handles](https://developer.apple.com/documentation/callkit/cxhandle/handletype/generic)
- [Displayed caller name](https://developer.apple.com/documentation/callkit/cxcallupdate/localizedcallername)
- [Phone Recents](https://developer.apple.com/documentation/callkit/cxproviderconfiguration/includescallsinrecents)
- [INStartCallIntent and system redial](https://developer.apple.com/documentation/intents/instartcallintent)
- [WKWebView microphone permission](https://developer.apple.com/documentation/webkit/wkuidelegate/webview(_:requestmediacapturepermissionfor:initiatedbyframe:type:decisionhandler:))
- [PushKit incoming calls](https://developer.apple.com/documentation/pushkit/responding-to-voip-notifications-from-pushkit)
- [Universal links](https://developer.apple.com/documentation/xcode/supporting-universal-links-in-your-app)
