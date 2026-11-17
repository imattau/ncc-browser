#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=android-env.sh
source "$SCRIPT_DIR/android-env.sh"

AVD_NAME="ncc-api-37-x86_64"
IMAGE="system-images;android-37.0;default;x86_64"
mkdir -p "$ANDROID_AVD_HOME"

if ! "$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager" list avd -c | grep -Fxq "$AVD_NAME"; then
  printf 'no\n' | "$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager" create avd \
    --name "$AVD_NAME" --package "$IMAGE" --force
fi

if ! adb -s emulator-5554 get-state 2>/dev/null | grep -Fxq device; then
  LOG_FILE="$ANDROID_USER_HOME/emulator.log"
  ACCEL_ARGS=()
  if [ ! -r /dev/kvm ] || [ ! -w /dev/kvm ]; then
    ACCEL_ARGS=(-accel off)
    echo "KVM is unavailable; starting the emulator with software CPU emulation."
  fi
  emulator -avd "$AVD_NAME" -port 5554 -no-window -no-audio -no-boot-anim \
    -no-snapshot -gpu swiftshader_indirect "${ACCEL_ARGS[@]}" >"$LOG_FILE" 2>&1 &
  EMULATOR_PID=$!
  echo "$EMULATOR_PID" > "$ANDROID_USER_HOME/emulator.pid"
else
  EMULATOR_PID=""
fi

export ANDROID_SERIAL=emulator-5554
adb -s "$ANDROID_SERIAL" wait-for-device
for _ in $(seq 1 360); do
  if [ "$(adb -s "$ANDROID_SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; then
    echo "Android emulator ready: $AVD_NAME (API 37, x86_64)"
    if [ -n "$EMULATOR_PID" ]; then
      echo "Leave this command running while using the emulator; stop it with Ctrl-C."
      wait "$EMULATOR_PID"
    fi
    exit 0
  fi
  sleep 2
done

echo "Emulator did not finish booting. Log: $ANDROID_USER_HOME/emulator.log" >&2
exit 1
