#!/bin/sh
set -eu
ios_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
check_dir=$(mktemp -d "${TMPDIR:-/tmp}/cloudbot-ios-check.XXXXXX")
trap 'rm -rf "$check_dir"' EXIT HUP INT TERM
swiftc -parse-as-library "$ios_root/Sources/SessionCallRoute.swift" "$ios_root/scripts/check-routing.swift" -o "$check_dir/check-routing"
"$check_dir/check-routing"
# Parsing detects syntax mistakes without claiming an iPhoneOS SDK type-check/build.
swiftc -frontend -parse "$ios_root/Sources/CustomCloudBotApp.swift" "$ios_root/Sources/SessionCallCoordinator.swift" "$ios_root/Sources/SessionCallRoute.swift"
