#!/usr/bin/env bash
# Prepares the Android SDK on a GitHub runner.
#
# `android-actions/setup-android@v3` is not used: it runs `sdkmanager tools`, a
# package Google has since removed, so the action fails before installing anything.
# The runner image already carries an SDK; this only installs the pieces we need and
# exports the environment for later steps.
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

yes | "$SDKMANAGER" --licenses >/dev/null 2>&1 || true
"$SDKMANAGER" --install \
  "platform-tools" \
  "platforms;android-35" \
  "build-tools;35.0.0" \
  "ndk;$NDK_VERSION"

{
  echo "ANDROID_HOME=$SDK"
  echo "ANDROID_SDK_ROOT=$SDK"
  echo "NDK_HOME=$SDK/ndk/$NDK_VERSION"
} >> "${GITHUB_ENV:-/dev/null}"

echo "sdkmanager: $SDKMANAGER"
echo "ndk: $SDK/ndk/$NDK_VERSION"
