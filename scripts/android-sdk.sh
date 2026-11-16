#!/usr/bin/env bash
# Prepares the Android SDK on a GitHub runner.
#
# `android-actions/setup-android@v3` is not used: it runs `sdkmanager tools`, a
# package Google has since removed, so the action fails before installing anything.
# The runner image already carries an SDK; this only installs the pieces we need and
# exports the environment for later steps.
#
# Android has minor SDK levels now (`android-37.0`, `android-37.1`, …), so the
# platform Tauri pins cannot be installed by appending its compileSdk to a string.
# Resolve the real package id from the remote repository listing.
set -euo pipefail

SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-/usr/local/lib/android/sdk}}"
if [ ! -d "$SDK" ]; then
  echo "Android SDK not found (looked at $SDK)" >&2
  exit 1
fi

SDKMANAGER=""
for candidate in "$SDK/cmdline-tools/latest/bin/sdkmanager" "$SDK"/cmdline-tools/*/bin/sdkmanager; do
  if [ -x "$candidate" ]; then
    SDKMANAGER="$candidate"
  fi
done
if [ -z "$SDKMANAGER" ]; then
  echo "sdkmanager not found under $SDK" >&2
  exit 1
fi

NDK_VERSION="${NDK_VERSION:-27.2.12479018}"

# Tauri pins `compileSdk` in the generated project; install whatever it asks for
# rather than a hardcoded level that goes stale on the next Tauri bump.
SDK_LEVEL="${ANDROID_SDK_LEVEL:-}"
if [ -z "$SDK_LEVEL" ] && [ -f src-tauri/gen/android/app/build.gradle.kts ]; then
  SDK_LEVEL=$(sed -n 's/.*compileSdk = \([0-9][0-9]*\).*/\1/p' src-tauri/gen/android/app/build.gradle.kts | head -1)
fi
SDK_LEVEL="${SDK_LEVEL:-35}"

LISTING=$(mktemp)
"$SDKMANAGER" --list > "$LISTING" 2>/dev/null || true

# `platforms;android-37` when it exists, else the highest `platforms;android-37.N`.
PLATFORM=$(printf '%s\n' "$LISTING" | grep -oE "platforms;android-${SDK_LEVEL}([.][0-9]+)?" | sort -uV | tail -1 || true)
if [ -z "$PLATFORM" ]; then
  echo "no SDK platform found for API level ${SDK_LEVEL}" >&2
  exit 1
fi

PACKAGES=("platform-tools" "$PLATFORM" "ndk;$NDK_VERSION")
if printf '%s\n' "$LISTING" | grep -qE "build-tools;${SDK_LEVEL}[.]0[.]0"; then
  PACKAGES+=("build-tools;${SDK_LEVEL}.0.0")
fi
rm -f "$LISTING"

yes | "$SDKMANAGER" --licenses >/dev/null 2>&1 || true
"$SDKMANAGER" --install "${PACKAGES[@]}"

{
  echo "ANDROID_HOME=$SDK"
  echo "ANDROID_SDK_ROOT=$SDK"
  echo "NDK_HOME=$SDK/ndk/$NDK_VERSION"
} >> "${GITHUB_ENV:-/dev/null}"

echo "sdkmanager: $SDKMANAGER"
echo "platform: $PLATFORM"
echo "ndk: $SDK/ndk/$NDK_VERSION"
