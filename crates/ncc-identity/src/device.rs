//! The Android keystore envelope.
//!
//! The key lives in `AndroidKeyStore`: generated on first use, non-exportable, and
//! never leaves the platform. Rust asks a small Kotlin object to seal and open, so the
//! secret exists in this process only while it is being used.
//!
//! The JNI call is deliberately tiny: one class, two static methods, one string in and
//! one string out. Everything that can fail becomes an `IdentityError` with the
//! platform message attached.

use jni::objects::{JClass, JObject, JString, JValue};
use jni::{JNIEnv, JavaVM};

use crate::{IdentityError, KeyEnvelope};

const BRIDGE_CLASS: &str = "io.github.imattau.nccbrowser.IdentityKey";

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

fn call(method: &str, input: &str) -> Result<String, IdentityError> {
    let context = ndk_context::android_context();
    // SAFETY: `ndk_context` holds the VM the app is running on; this is the pointer
    // every other Android crate uses to attach.
    let vm = unsafe { JavaVM::from_raw(context.vm().cast()) }
        .map_err(|error| failure("vm", error.to_string()))?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|error| failure("attach", error.to_string()))?;

    // `FindClass` on a thread Rust created resolves against the system loader, which
    // cannot see the app's classes. Go through the application context's loader.
    let app = unsafe { JObject::from_raw(context.context().cast()) };
    let class = bridge_class(&mut env, &app)?;

    let argument = env
        .new_string(input)
        .map_err(|error| failure("argument", error.to_string()))?;

    let result = env
        .call_static_method(
            class,
            method,
            "(Ljava/lang/String;)Ljava/lang/String;",
            &[JValue::Object(&JObject::from(argument))],
        )
        .map_err(|error| failure(method, error.to_string()))?;

    let object = result
        .l()
        .map_err(|error| failure(method, error.to_string()))?;
    let text: String = env
        .get_string(&JString::from(object))
        .map_err(|error| failure(method, error.to_string()))?
        .into();

    Ok(text)
}

fn bridge_class<'local>(
    env: &mut JNIEnv<'local>,
    app: &JObject<'local>,
) -> Result<JClass<'local>, IdentityError> {
    let loader = env
        .call_method(app, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])
        .and_then(|value| value.l())
        .map_err(|error| failure("class loader", error.to_string()))?;

    let name = env
        .new_string(BRIDGE_CLASS)
        .map_err(|error| failure("class name", error.to_string()))?;

    let class = env
        .call_method(
            loader,
            "loadClass",
            "(Ljava/lang/String;)Ljava/lang/Class;",
            &[JValue::Object(&JObject::from(name))],
        )
        .and_then(|value| value.l())
        .map_err(|error| failure("class", error.to_string()))?;

    Ok(JClass::from(class))
}

fn failure(stage: &str, detail: String) -> IdentityError {
    IdentityError::Crypto(format!("device keystore ({stage}): {detail}"))
}
