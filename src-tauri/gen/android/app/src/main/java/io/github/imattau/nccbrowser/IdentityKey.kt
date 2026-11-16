package io.github.imattau.nccbrowser

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The key that wraps the identity's secret, held by the Android keystore.
 *
 * Generated on first use, 256-bit AES-GCM, non-exportable: `seal` and `open` are the
 * only operations, so nothing outside this device can unwrap the stored identity. The
 * IV is prepended to the ciphertext, which is what makes `open` self-contained.
 *
 * Called from Rust over JNI (see `crates/ncc-identity/src/device.rs`), which is why
 * these are `@JvmStatic` on an object: one class, two static methods.
 */
object IdentityKey {
  private const val ALIAS = "ncc-identity"
  private const val TRANSFORMATION = "AES/GCM/NoPadding"
  private const val IV_BYTES = 12
  private const val TAG_BITS = 128

  @JvmStatic
  fun seal(plaintext: String): String {
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.ENCRYPT_MODE, key())
    val body = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
    return Base64.encodeToString(cipher.iv + body, Base64.NO_WRAP)
  }

  @JvmStatic
  fun open(sealed: String): String {
    val bytes = Base64.decode(sealed, Base64.NO_WRAP)
    require(bytes.size > IV_BYTES) { "sealed identity is too short" }

    val iv = bytes.copyOfRange(0, IV_BYTES)
    val body = bytes.copyOfRange(IV_BYTES, bytes.size)

    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(TAG_BITS, iv))
    return String(cipher.doFinal(body), Charsets.UTF_8)
  }

  /** Forget the wrapping key. The stored identity becomes unreadable, which is the
   * point of removing it. */
  @JvmStatic
  fun forget() {
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    if (store.containsAlias(ALIAS)) store.deleteEntry(ALIAS)
  }

  private fun key(): SecretKey {
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (store.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }

    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    generator.init(
      KeyGenParameterSpec.Builder(
        ALIAS,
        KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
      )
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        // No user-authentication requirement: unlocking the identity is a tap away,
        // and signing still asks for approval per service.
        .setUserAuthenticationRequired(false)
        .build(),
    )
    return generator.generateKey()
  }
}
