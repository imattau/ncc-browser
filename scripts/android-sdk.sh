#!/usr/bin/env bash
# Prepares the Android SDK on a GitHub runner.
#
# `android-actions/setup-android@v3` is not used: it runs `sdkmanager tools`, a
# package Google has since removed, so the action fails before installing anything.
# The runner image already carries an SDK; this only installs the pieces we need and
# exports the environment for later steps.
#
# Android has minor SDK levels now (`android-37.0`, `android-37.1`, `android-37.2`),
# so the platform Tauri pins cannot be built by appending its compileSdk to a
# string. Probe the candidate ids from newest to oldest and keep the first that
# sdkmanager accepts.
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

install_package() {
  "$SDKMANAGER" --install "$1" >/dev/null 2>&1
}

yes | "$SDKMANAGER" --licenses >/dev/null 2>&1 || true

PLATFORM=""
for candidate in \
  "platforms;android-${SDK_LEVEL}.2" \
  "platforms;android-${SDK_LEVEL}.1" \
  "platforms;android-${SDK_LEVEL}.0" \
  "platforms;android-${SDK_LEVEL}"; do
  if install_package "$candidate"; then
    PLATFORM="$candidate"
    break
  fi
done
if [ -z "$PLATFORM" ]; then
  echo "no installable SDK platform for API level ${SDK_LEVEL}" >&2
  exit 1
fi

BUILD_TOOLS=""
for candidate in "build-tools;${SDK_LEVEL}.0.0" "build-tools;${SDK_LEVEL}.0.0-rc1"; do
  if install_package "$candidate"; then
    BUILD_TOOLS="$candidate"
    break
  fi
done

if ! install_package "platform-tools"; then
  echo "could not install platform-tools" >&2
  exit 1
fi
if ! install_package "ndk;$NDK_VERSION"; then
  echo "could not install ndk;$NDK_VERSION" >&2
  exit 1
fi

{
  echo "ANDROID_HOME=$SDK"
  echo "ANDROID_SDK_ROOT=$SDK"
  echo "NDK_HOME=$SDK/ndk/$NDK_VERSION"
} >> "${GITHUB_ENV:-/dev/null}"

echo "sdkmanager: $SDKMANAGER"
echo "platform: $PLATFORM"
echo "build-tools: ${BUILD_TOOLS:-<from runner image>}"
echo "ndk: $SDK/ndk/$NDK_VERSION"
