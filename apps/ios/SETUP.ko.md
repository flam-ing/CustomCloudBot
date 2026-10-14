# iPhone 설치와 Apple 서명

이 앱은 웹사이트를 홈 화면에 추가하는 PWA와 별개의 **네이티브 iPhone 앱**입니다.
통화 중 화면을 꺼도 오디오를 유지하고, 전화 앱의 최근 통화에서 해당 대화로
다시 전화하려면 iPhone에 이 앱을 설치해야 합니다. 서버 배포만으로 iPhone에
설치되지는 않습니다.

## 1. Xcode 설치

Mac App Store에서 [Xcode](https://developer.apple.com/xcode/resources/)를 설치하고
한 번 실행합니다. 처음 시작할 때 iOS 플랫폼을 설치합니다. Xcode는 무료이고,
Command Line Tools만 설치되어 있으면 iPhone 앱을 빌드할 수 없습니다.

Xcode에서 **Settings → Locations → Command Line Tools**가 설치한 Xcode를
가리키도록 선택합니다.

## 2. Apple 계정 로그인

**Xcode → Settings → Accounts → + → Apple Account**에서 본인 계정으로
로그인합니다. 비밀번호·2단계 인증은 Xcode에 직접 입력합니다.

Apple 서명은 이 앱을 어느 개발자 계정으로 만들었는지 확인하고, 설치할 기기를
허용하는 절차입니다. 아래의 자동 서명을 사용하면 인증서 파일을 직접 만들거나
서버에 Apple 비밀번호를 저장할 필요가 없습니다.

- **내 iPhone에서 먼저 테스트:** 무료 계정의 Personal Team으로 시작할 수 있습니다.
  무료 프로비저닝은 7일 뒤 만료되므로 그때 Xcode에서 다시 빌드해 설치해야 합니다.
- **TestFlight·App Store 배포:** Apple Developer Program 가입이 필요합니다.
  공식 기본 요금은 연 US$99이며 실제 가입 화면에 지역별 통화와 요금이 표시됩니다.
  가입과 결제는 필요할 때 본인이 진행하면 됩니다.

현재 앱에 필요한 발신 통화·백그라운드 오디오에는 APNs 인증서가 필요하지 않습니다.
Apple의 기능표에서 Background modes는 무료 계정에도 허용되어 있습니다.
다른 사람이 거는 전화를 앱이 종료된 상태에서도 받는 기능은 별도 PushKit/APNs
작업이며 이 버전에는 포함되지 않습니다.

## 3. 프로젝트 열기

저장소의 `apps/ios` 폴더에서 다음을 실행합니다.

```sh
brew install xcodegen
xcodegen generate --no-env
open CustomCloudBot.xcodeproj
```

이미 XcodeGen이 있으면 첫 명령은 생략합니다. 프로젝트는 공개 `project.yml`에서
생성되며, 개인 팀이나 서버 주소는 기본값에 포함되어 있지 않습니다.

Xcode에서 프로젝트 → **TARGETS → CustomCloudBot**을 선택한 다음:

1. **Signing & Capabilities → Automatically manage signing**을 켭니다.
2. **Team**에서 본인 Apple 계정 또는 Personal Team을 선택합니다.
3. **Bundle Identifier**를 본인이 사용할 고유 값으로 바꿉니다.
   예: `org.example.mycustomcloudbot`의 `example` 부분을 자신의 고유 이름으로 변경합니다.
4. **Build Settings → All**에서 `CLOUDBOT_ORIGIN`이 본인 서버의 HTTPS 주소인지
   확인합니다. 경로·로그인 토큰·API 키는 넣지 않습니다.

개인 설정을 유지하려면 Git에서 제외된 `Config.local.xcconfig` 파일을 사용합니다.
이 파일은 프로젝트를 다시 생성해도 유지됩니다. Fork해서 처음 설치하는 경우 예시는
다음과 같습니다. `$()`는 `https://`의 `//`가 주석으로 잘못 처리되는 것을 방지합니다.

```xcconfig
PRODUCT_BUNDLE_IDENTIFIER = org.example.mycustomcloudbot
DEVELOPMENT_TEAM =
CLOUDBOT_ORIGIN = https:/$()/bot.example.org
```

팀을 Xcode에서만 선택하고 프로젝트를 재생성하면 팀 선택이 초기화됩니다.
유지하려면 위 파일의 `DEVELOPMENT_TEAM`에 본인 팀 ID를 넣습니다.
앱 서버의 API 키는 iPhone 프로젝트에 복사하지 않습니다.

## 4. iPhone 연결 및 실행

1. iPhone을 USB로 Mac에 연결하고, 기기에서 이 컴퓨터를 신뢰합니다.
2. Xcode 상단의 실행 대상에서 본인 iPhone을 선택합니다.
3. 요청되면 iPhone **설정 → 개인정보 보호 및 보안 → 개발자 모드**를 켜고
   재시동 후 한 번 더 확인합니다. 이 메뉴는 Xcode와 기기를 연결한 뒤 나타날 수 있습니다.
4. Xcode의 ▶ Run을 누릅니다. 서명·설치는 Xcode가 처리합니다.
5. 앱 안에서 평소 계정으로 로그인하고, 대화의 전화 버튼을 누릅니다.
   첫 통화 때 마이크 사용을 허용합니다.

## 5. 실제 기기에서 확인

시뮬레이터나 서명 없는 빌드 통과만으로 잠금 화면·최근 통화가 검증되지는 않습니다.
다음 확인을 마쳐야 실제 iPhone에서 사용 가능한 상태라고 판단할 수 있습니다.

- 서로 다른 대화 A/B에서 통화하고, 시스템 통화 화면과 최근 통화에 각각의 제목이 나오는지 확인합니다.
- 통화 중 화면을 잠그고, 말하기·답변 듣기가 계속되는지 확인합니다.
- 전화를 끊은 뒤 **전화 → 최근 통화 → A**를 눌러 A의 기존 맥락으로 다시 연결되는지 확인합니다.
- 앱을 완전히 종료한 뒤에도 최근 통화에서 같은 세션으로 다시 연결되는지 확인합니다.
- 제목이 바뀌어도 같은 세션으로 연결되는지, 삭제되거나 권한이 없는 세션은 연결되지 않는지 확인합니다.
- 잠금 화면에서 종료·음소거, Bluetooth 연결, 셀룰러 전화로 인한 오디오 중단을 확인합니다.
- 로그아웃한 상태에서는 재로그인이 필요하고, 이전 사용자의 세션이 열리지 않아야 합니다.

최근 통화의 제목은 통화할 때의 제목일 수 있습니다. 세션을 찾는 주소는 바뀌지 않는
대화 ID이므로, 제목을 바꾸거나 같은 이름의 대화가 여러 개 있어도 연결 대상을 구분합니다.

## Apple 공식 안내

- [Xcode 다운로드](https://developer.apple.com/xcode/resources/)
- [무료 Personal Team과 7일 만료](https://developer.apple.com/help/account/basics/about-your-developer-account)
- [자동 서명과 실제 기기 실행](https://help.apple.com/xcode/mac/current/en.lproj/dev60b6fbbc7.html)
- [iPhone 개발자 모드](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device)
- [멤버십별 사용 가능한 기능](https://developer.apple.com/help/account/reference/supported-capabilities-ios)
- [유료 멤버십 요금](https://developer.apple.com/programs/enroll/)
