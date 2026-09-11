package chat.reaper.scanner

import androidx.activity.result.ActivityResult
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
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
 * its own capture screen and asks for the camera permission itself.
 *
 * It exists for one thing — pairing two of your own devices. A desktop shows
 * its sync address as a code; typing sixty-two base32 characters on a phone
 * without a mistake is not a reasonable thing to ask of anyone.
 */
@CapacitorPlugin(name = "Scanner")
class ScannerPlugin : Plugin() {

    @PluginMethod
    fun scan(call: PluginCall) {
        // QR only. Accepting every barcode type the camera can read means a
        // shop receipt in view is a "successful" scan. The embedded capture
        // screen requests the CAMERA permission on its own before it opens,
        // and closes straight back to us if it is refused.
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
