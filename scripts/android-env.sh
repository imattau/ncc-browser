# Source this file to use the project-local Android development toolchain.
# The SDK, Gradle cache, AVD data, and Rust helper stay in .android-toolchain/.

_NCC_ANDROID_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
_NCC_ANDROID_HOME="$_NCC_ANDROID_ROOT/.android-toolchain"

if [ ! -x "$_NCC_ANDROID_HOME/jdk/bin/java" ] || \
   [ ! -x "$_NCC_ANDROID_HOME/sdk/platform-tools/adb" ]; then
  echo "Android toolchain is incomplete. See docs/android.md (Local setup)." >&2
  return 1 2>/dev/null || exit 1
fi

export JAVA_HOME="$_NCC_ANDROID_HOME/jdk"
export ANDROID_HOME="$_NCC_ANDROID_HOME/sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export ANDROID_NDK_HOME="$ANDROID_SDK_ROOT/ndk/27.2.12479018"
export NDK_HOME="$ANDROID_NDK_HOME"
export ANDROID_USER_HOME="$_NCC_ANDROID_HOME/android-user"
export ANDROID_EMULATOR_HOME="$ANDROID_USER_HOME"
export ANDROID_AVD_HOME="$ANDROID_USER_HOME/avd"
export GRADLE_USER_HOME="$_NCC_ANDROID_HOME/gradle"
export CARGO_HOME="$_NCC_ANDROID_HOME/cargo"
export PATH="$_NCC_ANDROID_HOME/cargo/bin:$ANDROID_SDK_ROOT/cmdline-tools/latest/bin:$ANDROID_SDK_ROOT/platform-tools:$ANDROID_SDK_ROOT/emulator:$JAVA_HOME/bin:$PATH"

unset _NCC_ANDROID_ROOT _NCC_ANDROID_HOME
