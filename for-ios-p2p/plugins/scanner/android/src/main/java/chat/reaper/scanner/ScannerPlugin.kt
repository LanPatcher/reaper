package chat.reaper.scanner

import android.Manifest
import androidx.activity.result.ActivityResult
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import com.journeyapps.barcodescanner.ScanIntentResult
import com.journeyapps.barcodescanner.ScanOptions
import org.json.JSONObject

/**
 * A QR reader, using the camera and a self-contained decoder.
 *
 * The counterpart to the iOS plugin, and it keeps the same contract: open the
 * camera, resolve with the first code seen, resolve with null when the user
 * backs out, reject only when there is no camera or permission was refused.
 *
 * Where iOS leans on AVFoundation's own detector, Android has no equivalent in
 * the framework, so this uses ZXing's embedded scanner (journeyapps). That was
 * a deliberate choice over Google's ML Kit / Play "code scanner": those pull in
 * Google Play Services, which a Tor-only, serverless app has no business
 * requiring and which simply is not present on the de-Googled ROMs a chunk of
 * this app's users run. ZXing is a pure, offline, no-Google decoder that ships
 * its own capture screen.
 *
 * Permission is asked for HERE, explicitly, before the scanner opens — exactly
 * as the iOS plugin asks AVCaptureDevice for authorization first. Leaving it to
 * the capture screen to request looked like "could not start camera" with no
 * prompt at all on some devices; requesting it through Capacitor's own
 * permission machinery gets the system dialog reliably, and only launches the
 * camera once it is actually granted.
 *
 * It exists for one thing — pairing two of your own devices. A desktop shows
 * its sync address as a code; typing sixty-two base32 characters on a phone
 * without a mistake is not a reasonable thing to ask of anyone.
 */
@CapacitorPlugin(
    name = "Scanner",
    permissions = [
        Permission(alias = ScannerPlugin.CAMERA, strings = [Manifest.permission.CAMERA]),
    ],
)
class ScannerPlugin : Plugin() {

    companion object {
        const val CAMERA = "camera"
    }

    @PluginMethod
    fun scan(call: PluginCall) {
        if (getPermissionState(CAMERA) == PermissionState.GRANTED) {
            launchScanner(call)
        } else {
            // First run, or a previous denial. Ask now; `cameraCallback` picks
            // the call back up once the user has answered the system dialog.
            requestPermissionForAlias(CAMERA, call, "cameraCallback")
        }
    }

    @PermissionCallback
    private fun cameraCallback(call: PluginCall) {
        if (getPermissionState(CAMERA) == PermissionState.GRANTED) {
            launchScanner(call)
        } else {
            // Refused. Not an error worth alarming anybody with — the address
            // can still be typed — but the caller has to be able to tell it
            // apart from a scan that found nothing, or it will sit waiting for
            // a camera that is never going to open.
            call.reject("the camera was not allowed")
        }
    }

    private fun launchScanner(call: PluginCall) {
        // QR only. Accepting every barcode type the camera can read means a
        // shop receipt in view is a "successful" scan.
        val options = ScanOptions().apply {
            setDesiredBarcodeFormats(ScanOptions.QR_CODE)
            setPrompt("Point at the code on your other device")
            setBeepEnabled(false)
            setBarcodeImageEnabled(false)
            setOrientationLocked(false)
        }

        val intent = options.createScanIntent(activity)
        startActivityForResult(call, intent, "scanResult")
    }

    @ActivityCallback
    private fun scanResult(call: PluginCall?, result: ActivityResult) {
        // The bridge holds the only reference to the call; if the process was
        // rebuilt while the camera was open it can be gone, and there is
        // nothing to resolve.
        if (call == null) return

        val scan = ScanIntentResult.parseActivityResult(result.resultCode, result.data)

        // `contents` is null when the user backed out — an ordinary outcome,
        // resolved as null rather than rejected so the one call site does not
        // need a catch that has to work out whether anything went wrong. Put
        // JSONObject.NULL explicitly: JSObject.put drops a Kotlin null key
        // entirely, and the interface reads `text` back off the object.
        val ret = JSObject()
        ret.put("text", scan.contents ?: JSONObject.NULL)
        call.resolve(ret)
    }
}
