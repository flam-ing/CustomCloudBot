#!/bin/sh
set -eu
ios_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

if ! command -v xcodegen >/dev/null 2>&1; then
  echo 'XcodeGen is required: brew install xcodegen' >&2
  exit 1
fi
if ! xcrun --sdk iphoneos --show-sdk-path >/dev/null 2>&1; then
  echo 'Install full Xcode with the iOS platform, then select Xcode > Settings > Locations > Command Line Tools.' >&2
  echo 'Command Line Tools alone cannot build an iPhone app.' >&2
  exit 1
fi

# Recreate the public template; this does not download or use signing credentials.
xcodegen generate --no-env --spec "$ios_root/project.yml" --project "$ios_root"
xcodebuild -project "$ios_root/CustomCloudBot.xcodeproj" \
  -scheme CustomCloudBot -configuration Debug \
  -destination 'generic/platform=iOS' \
  -derivedDataPath "$ios_root/DerivedData" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO \
  DEVELOPMENT_TEAM= CLOUDBOT_ORIGIN= build
