//! The Android keystore envelope.
//!
//! The key lives in `AndroidKeyStore`: generated on first use, non-exportable, and
//! never leaves the platform. Rust asks a small Kotlin object to seal and open, so the
//! secret exists in this process only while it is being used.
//!
//! The bridge is resolved in [`JNI_OnLoad`], not on first use. `ndk_context` is not an
//! option here: Tauri never initialises it (only `android-activity` does, and that
//! crate is not in this dependency graph), and its accessor is an `expect`, so the
//! first call aborted the process. The JVM calls `JNI_OnLoad` when it loads this
//! library, and per the JNI spec `FindClass` there resolves against the loader that
//! loaded the library — the app's. From a thread Rust created, `FindClass` would use
//! the system loader and never see our own classes.

use std::ffi::c_void;
use std::sync::OnceLock;

use jni::objects::{GlobalRef, JObject, JString, JValue};
use jni::sys::{jint, JNI_VERSION_1_6};
use jni::{JNIEnv, JavaVM};

use crate::{IdentityError, KeyEnvelope};

const BRIDGE_CLASS: &str = "io/github/imattau/nccbrowser/IdentityKey";
const BRIDGE_SIGNATURE: &str = "(Ljava/lang/String;)Ljava/lang/String;";

struct Bridge {
    vm: JavaVM,
    class: GlobalRef,
}

/// Filled once, when the library loads. A failure is remembered instead of raised: an
/// app that refuses to start is worse than one that says the identity is unavailable.
static BRIDGE: OnceLock<Result<Bridge, String>> = OnceLock::new();

pub struct DeviceEnvelope;

impl KeyEnvelope for DeviceEnvelope {
    fn kind(&self) -> &'static str {
        "device"
    }

    fn seal(&self, plaintext: &str) -> Result<String, IdentityError> {
        call("seal", plaintext)
    }

    fn open(&self, sealed: &str) -> Result<String, IdentityError> {
        call("open", sealed)
    }
}

/// Called by the JVM when it loads this library, before any of our code runs.
///
/// This is the one `unsafe` in the crate, and it is `unsafe` for the honest reason: the
/// pointer is only valid when the JVM passes this function the VM that loaded us, which
/// it always does. Everything else in the crate denies `unsafe`.
///
/// # Safety
///
/// Called by the JVM. `raw` must be the `JavaVM*` the loader handed to this function.
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "system" fn JNI_OnLoad(
    raw: *mut jni::sys::JavaVM,
    _reserved: *mut c_void,
) -> jint {
    let result = JavaVM::from_raw(raw)
        .map_err(|error| format!("no JVM: {error}"))
        .and_then(bridge);

    // Deliberately ignored: reporting the version keeps the library loadable, and the
    // error is surfaced the first time an identity is created or opened.
    let _ = BRIDGE.set(result);

    JNI_VERSION_1_6
}

fn bridge(vm: JavaVM) -> Result<Bridge, String> {
    let mut env = vm
        .get_env()
        .map_err(|error| format!("not attached while loading: {error}"))?;

    let class = match env.find_class(BRIDGE_CLASS) {
        Ok(class) => class,
        // `find_class` leaves the failure as a pending Java exception, which has to be
        // cleared before anything else touches this thread.
        Err(error) => return Err(detail(&mut env, error)),
    };

    let class = env
        .new_global_ref(class)
        .map_err(|error| detail(&mut env, error))?;

    Ok(Bridge { vm, class })
}

fn call(method: &str, input: &str) -> Result<String, IdentityError> {
    let bridge = match BRIDGE.get() {
        Some(Ok(bridge)) => bridge,
        Some(Err(problem)) => return Err(failure("init", problem.clone())),
        None => return Err(failure("init", "the JVM never loaded this library".into())),
    };

    let mut env = bridge
        .vm
        .attach_current_thread()
        .map_err(|error| failure("attach", error.to_string()))?;

    let argument = env
        .new_string(input)
        .map_err(|error| failure("argument", error.to_string()))?;

    let called = env.call_static_method(
        &bridge.class,
        method,
        BRIDGE_SIGNATURE,
        &[JValue::Object(&JObject::from(argument))],
    );

    let value = match called {
        Ok(value) => value,
        Err(error) => return Err(failure(method, detail(&mut env, error))),
    };

    let object = value
        .l()
        .map_err(|error| failure(method, error.to_string()))?;
    let text: String = env
        .get_string(&JString::from(object))
        .map_err(|error| failure(method, error.to_string()))?
        .into();

    Ok(text)
}

/// A JNI failure, with the Java exception's own message attached when there is one.
///
/// The exception is cleared on purpose: it is pending on a thread Tauri keeps using,
/// and leaving it would poison every later JNI call on that thread.
fn detail(env: &mut JNIEnv, error: jni::errors::Error) -> String {
    let mut message = error.to_string();

    let throwable = env.exception_occurred().ok();
    let _ = env.exception_clear();

    // Safe to call now that no exception is pending.
    if let Some(throwable) = throwable {
        if let Ok(text) = env.call_method(&throwable, "toString", "()Ljava/lang/String;", &[]) {
            if let Ok(object) = text.l() {
                if let Ok(text) = env.get_string(&JString::from(object)) {
                    message = format!("{message}: {}", String::from(text));
                }
            }
        }
    }

    message
}

fn failure(stage: &str, detail: String) -> IdentityError {
    IdentityError::Crypto(format!("device keystore ({stage}): {detail}"))
}
