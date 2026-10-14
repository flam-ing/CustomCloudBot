# CustomCloudBot iOS calls

The native iOS app embeds the existing website for sign-in and chats, and uses
CallKit plus native audio and networking for voice calls. Calls belong to immutable
chat room IDs; the system call UI displays the current chat title. Phone Recents
redial reconnects to that same room after checking the current login and membership.

This is an outgoing app-to-agent call. It does not require a telephone number or
PSTN provider, and it does not implement incoming ringing via PushKit/APNs. Audio
conversation uses the server's existing speech-to-text path and iOS speech synthesis
for replies; it is turn-based voice, not a new real-time model subscription.

## Build and install

See [the Korean installation and signing guide](SETUP.ko.md) for the complete
Xcode, Apple Account, free Personal Team, device, and verification steps.

Requirements: full Xcode with the iOS platform, XcodeGen, a signing team for device
installation, and a physical iPhone for background audio and Phone Recents testing.
Command Line Tools alone cannot compile UIKit/CallKit or install an iPhone app.

```sh
brew install xcodegen
cd apps/ios
xcodegen generate --no-env
open CustomCloudBot.xcodeproj
```

Public settings in `Config.xcconfig` use a generic bundle identifier, blank signing
team, and blank server origin. A blank origin shows a setup message. Create an
ignored `Config.local.xcconfig` for a particular installation:

```xcconfig
PRODUCT_BUNDLE_IDENTIFIER = org.example.mycustomcloudbot
DEVELOPMENT_TEAM =
CLOUDBOT_ORIGIN = https:/$()/bot.example.org
```

The `$()` prevents xcconfig from treating `//` in an HTTPS URL as a comment.
Use one HTTPS origin without a path, query, credentials, or fragment. HTTP/localhost
are rejected. Do not add the server's model API keys or login tokens to this file.
The optional local include survives regenerating the Xcode project. CI works
without it. Generated project files, Info.plist, and all `*.local.xcconfig` files
are ignored by Git.

In Xcode, select the CustomCloudBot target, enable **Automatically manage signing**,
and select your **Team**. Connect your iPhone, enable Developer Mode if asked,
select it as the run destination, and press Run. Xcode manages the development
certificate and provisioning profile. Team changes made only in the generated
project are replaced on regeneration; set `DEVELOPMENT_TEAM` in the ignored local
file to preserve them.

Free Personal Team provisioning expires after seven days and requires another
build/install. Apple permits Background modes for free developers. TestFlight,
App Store distribution, and push notification capabilities require the appropriate
paid developer membership; no subscription, signing assets, or Apple service is
purchased or provisioned by this repository.

## Call identity and authentication

Each room UUID is a generic CallKit handle. Titles are display metadata, never the
routing key, so renaming a room does not change its call address. Calls are included
in Phone Recents. A recent entry may retain the title from the original call.

`INStartCallIntent` and the older `INStartAudioCallIntent` route a system redial to
the recorded room, including a cold launch. Authentication and current membership
are checked before reconnecting. Deleted or inaccessible rooms must fail rather
than falling back to a different chat. Ordinary custom links
`customcloudbot://call/<room-uuid>` open that room's call screen. No origin, token,
title, arbitrary path, or command is accepted in a custom URL. Universal links and
Siri voice commands are not enabled.

Only the main frame at the configured HTTPS origin can use the native bridge.
Cross-origin pages cannot initiate a native call; external web links open in the
system browser. The web view's normal authenticated session authorizes native
server requests. Provider API keys remain on the server.

Native audio starts only after CallKit activates the audio session, and stops on
hangup or failure. `UIBackgroundModes` includes `audio`; the microphone, playback,
and voice requests run natively during a call, without relying on WebKit timers
or the visibility of the website. System mute controls target the active call.
Lock-screen continuity is intended for an active call, not permission to keep an
idle app running forever or recover a call after force quit.

## Validation

```sh
sh apps/ios/scripts/check.sh
sh apps/ios/scripts/build.sh
```

`check.sh` executes Foundation routing, WAV/utterance, and response protocol checks,
then parses all Swift sources. It is
useful on a Mac with only Command Line Tools, but does not type-check iOS APIs.
`build.sh` regenerates the project and compiles against the real iPhoneOS SDK with
signing disabled, a blank origin, and no Apple credentials. The separate **iOS**
GitHub Actions workflow runs both checks on macOS for iOS changes; it does not
install, sign, or distribute the app, or modify the OCI deployment workflow.

An unsigned successful build does not verify physical device behavior. Before
calling this a released iPhone feature, complete the checklist in `SETUP.ko.md`:
screen lock, Bluetooth, system hangup/mute, cellular interruption, cold-launch
Recents redial, login expiry, renamed rooms, and inaccessible/deleted rooms.

## Apple references

- [CallKit](https://developer.apple.com/documentation/callkit)
- [Call lifecycle and audio activation](https://developer.apple.com/documentation/callkit/making-and-receiving-voip-calls)
- [Phone Recents](https://developer.apple.com/documentation/callkit/cxproviderconfiguration/includescallsinrecents)
- [INStartCallIntent and system redial](https://developer.apple.com/documentation/intents/instartcallintent)
- [Audio session categories and background audio](https://developer.apple.com/library/archive/documentation/Audio/Conceptual/AudioSessionProgrammingGuide/AudioSessionCategoriesandModes/AudioSessionCategoriesandModes.html)
- [Membership capabilities](https://developer.apple.com/help/account/reference/supported-capabilities-ios)
- [Free Personal Team limits](https://developer.apple.com/help/account/basics/about-your-developer-account)
- [Automatic signing](https://help.apple.com/xcode/mac/current/en.lproj/dev60b6fbbc7.html)
- [Xcode download](https://developer.apple.com/xcode/resources/)
