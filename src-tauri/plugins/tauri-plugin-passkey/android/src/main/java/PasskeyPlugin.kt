/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Android passkey plugin for Tauri. Runs the ceremony through Credential Manager
// and resolves the same base64url fields as the iOS plugin, which the webview
// assembles into a WebAuthn response JSON. Credential Manager speaks WebAuthn
// JSON, so the request is built here from the shared byte-level arguments: the
// server's options never reach it, and the PRF output comes back separately.

package net.thunderbird.thunderbolt.passkey

import android.app.Activity
import android.os.Build
import android.util.Base64
import androidx.core.content.ContextCompat
import androidx.credentials.CreateCredentialResponse
import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.CreatePublicKeyCredentialResponse
import androidx.credentials.CredentialManager
import androidx.credentials.CredentialManagerCallback
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetCredentialResponse
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import androidx.credentials.exceptions.CreateCredentialCancellationException
import androidx.credentials.exceptions.CreateCredentialException
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.domerrors.NotAllowedError
import androidx.credentials.exceptions.publickeycredential.CreatePublicKeyCredentialDomException
import androidx.credentials.exceptions.publickeycredential.GetPublicKeyCredentialDomException
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

// --- Invoke argument shapes (match src/models.rs, camelCase) ---
@InvokeArg
class RegisterArgs {
    lateinit var rpId: String
    lateinit var challenge: IntArray
    lateinit var userId: IntArray
    lateinit var userName: String
    var excludeCredentials: List<IntArray> = emptyList()
    var prfSalt: IntArray = IntArray(0)
}

@InvokeArg
class AuthenticateArgs {
    lateinit var rpId: String
    lateinit var challenge: IntArray
    var allowCredentials: List<IntArray> = emptyList()
    var prfSalt: IntArray = IntArray(0)
}

/** The reject code for a dismissed sheet; src/mobile.rs maps it to `Error::Cancelled`. */
private const val CANCELLED_CODE = "cancelled"

private fun IntArray.base64Url(): String =
    Base64.encodeToString(ByteArray(size) { this[it].toByte() }, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)

private fun credentialDescriptors(ids: List<IntArray>): JSONArray =
    JSONArray(ids.map { JSONObject().put("type", "public-key").put("id", it.base64Url()) })

/** The PRF extension input, or none for an empty salt, which leaves PRF out. */
private fun prfExtension(salt: IntArray): JSONObject =
    if (salt.isEmpty()) {
        JSONObject()
    } else {
        JSONObject().put("prf", JSONObject().put("eval", JSONObject().put("first", salt.base64Url())))
    }

/** The string at `name`, or empty when it's missing or JSON null (optString gives "null" for null). */
private fun JSONObject.stringOrEmpty(name: String): String = if (isNull(name)) "" else optString(name)

/** The PRF output, base64url, or empty when the provider returned none. */
private fun prfOutput(response: JSONObject): String =
    response.optJSONObject("clientExtensionResults")
        ?.optJSONObject("prf")
        ?.optJSONObject("results")
        ?.stringOrEmpty("first")
        .orEmpty()

@TauriPlugin
class PasskeyPlugin(private val activity: Activity) : Plugin(activity) {
    private val credentialManager by lazy { CredentialManager.create(activity) }
    private val mainExecutor by lazy { ContextCompat.getMainExecutor(activity) }

    @Command
    fun register(invoke: Invoke) {
        if (!passkeysSupported(invoke)) return
        val args = invoke.parseArgs(RegisterArgs::class.java)
        val requestJson = JSONObject()
            .put("challenge", args.challenge.base64Url())
            .put("rp", JSONObject().put("id", args.rpId).put("name", args.rpId))
            .put(
                "user",
                JSONObject()
                    .put("id", args.userId.base64Url())
                    .put("name", args.userName)
                    .put("displayName", args.userName),
            )
            .put(
                "pubKeyCredParams",
                JSONArray()
                    .put(JSONObject().put("type", "public-key").put("alg", -7))
                    .put(JSONObject().put("type", "public-key").put("alg", -257)),
            )
            .put("excludeCredentials", credentialDescriptors(args.excludeCredentials))
            .put(
                "authenticatorSelection",
                JSONObject()
                    .put("residentKey", "required")
                    .put("requireResidentKey", true)
                    .put("userVerification", "required"),
            )
            .put("attestation", "none")
            .put("extensions", prfExtension(args.prfSalt))

        credentialManager.createCredentialAsync(
            activity,
            CreatePublicKeyCredentialRequest(requestJson.toString()),
            null,
            mainExecutor,
            object : CredentialManagerCallback<CreateCredentialResponse, CreateCredentialException> {
                override fun onResult(result: CreateCredentialResponse) {
                    val created = result as? CreatePublicKeyCredentialResponse
                    if (created == null) {
                        invoke.reject("Unexpected credential type ${result.type}.")
                        return
                    }
                    resolveFromJson(invoke, created.registrationResponseJson) { credential, response ->
                        JSObject()
                            .put("id", credential.getString("id"))
                            .put("rawId", credential.getString("rawId"))
                            .put("clientDataJson", response.getString("clientDataJSON"))
                            .put("attestationObject", response.getString("attestationObject"))
                            .put("prfOutput", prfOutput(credential))
                    }
                }

                override fun onError(e: CreateCredentialException) {
                    rejectCeremony(invoke, e)
                }
            },
        )
    }

    @Command
    fun authenticate(invoke: Invoke) {
        if (!passkeysSupported(invoke)) return
        val args = invoke.parseArgs(AuthenticateArgs::class.java)
        // Empty allowCredentials for sign-in (any passkey for the RP); one id for sync unlock.
        val requestJson = JSONObject()
            .put("challenge", args.challenge.base64Url())
            .put("rpId", args.rpId)
            .put("allowCredentials", credentialDescriptors(args.allowCredentials))
            .put("userVerification", "required")
            .put("extensions", prfExtension(args.prfSalt))

        credentialManager.getCredentialAsync(
            activity,
            GetCredentialRequest(listOf(GetPublicKeyCredentialOption(requestJson.toString()))),
            null,
            mainExecutor,
            object : CredentialManagerCallback<GetCredentialResponse, GetCredentialException> {
                override fun onResult(result: GetCredentialResponse) {
                    val passkey = result.credential as? PublicKeyCredential
                    if (passkey == null) {
                        invoke.reject("Unexpected credential type ${result.credential.type}.")
                        return
                    }
                    resolveFromJson(invoke, passkey.authenticationResponseJson) { credential, response ->
                        JSObject()
                            .put("id", credential.getString("id"))
                            .put("rawId", credential.getString("rawId"))
                            .put("clientDataJson", response.getString("clientDataJSON"))
                            .put("authenticatorData", response.getString("authenticatorData"))
                            .put("signature", response.getString("signature"))
                            .put("userHandle", response.stringOrEmpty("userHandle"))
                            .put("prfOutput", prfOutput(credential))
                    }
                }

                override fun onError(e: GetCredentialException) {
                    rejectCeremony(invoke, e)
                }
            },
        )
    }

    // A provider's response JSON is outside our control (third-party providers
    // included): a malformed one rejects the ceremony instead of crashing the app.
    private fun resolveFromJson(
        invoke: Invoke,
        json: String,
        fields: (credential: JSONObject, response: JSONObject) -> JSObject,
    ) {
        try {
            val credential = JSONObject(json)
            invoke.resolve(fields(credential, credential.getJSONObject("response")))
        } catch (e: JSONException) {
            invoke.reject("Unreadable passkey response: ${e.message}")
        }
    }

    // Credential Manager passkeys need Android 9; the app itself supports older versions.
    private fun passkeysSupported(invoke: Invoke): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) return true
        invoke.reject("passkeys need Android 9")
        return false
    }

    // Google Play services reports a dismissed sheet as a NotAllowedError, as
    // browsers do, rather than as a cancellation exception.
    private fun isCancellation(e: Exception): Boolean =
        e is GetCredentialCancellationException ||
            e is CreateCredentialCancellationException ||
            (e is GetPublicKeyCredentialDomException && e.domError is NotAllowedError) ||
            (e is CreatePublicKeyCredentialDomException && e.domError is NotAllowedError)

    private fun rejectCeremony(invoke: Invoke, e: Exception) {
        if (isCancellation(e)) {
            invoke.reject("passkey ceremony cancelled", CANCELLED_CODE)
        } else {
            invoke.reject(e.message ?: e.javaClass.simpleName)
        }
    }
}
