package chat.reaper.preview

import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URL
import javax.net.ssl.SNIHostName
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory

/**
 * One HTTPS GET, over Tor, for link previews — the Android counterpart to the
 * desktop's native/torFetch.ts.
 *
 * The interface is forbidden by CSP from fetching anything itself (a remote
 * image in a message would be loaded over the ordinary network and leak the
 * reader's real IP). The desktop does the fetch in its main process over Tor
 * and hands back a data: URL; a phone has no main process, so this plugin does
 * the same job through Tor's local SOCKS proxy and returns the bytes for the
 * bridge to turn into a data: URL.
 *
 * Crucially the SOCKS CONNECT is sent with the destination as a DOMAIN NAME
 * (ATYP 0x03), so Tor resolves it inside the network — the device never does a
 * DNS lookup for the host, which would be a plaintext leak of what is being
 * previewed. TLS then runs end-to-end over that tunnel, so the exit node sees
 * only ciphertext.
 *
 * Redirects are NOT followed here; whether a redirect may be followed is an
 * allowlist decision, so the bridge (like the desktop's remote.ts) makes it and
 * calls again. This is only "open the tunnel, do the GET, read the answer".
 */
@CapacitorPlugin(name = "Preview")
class PreviewPlugin : Plugin() {

    @PluginMethod
    fun httpGet(call: PluginCall) {
        val urlStr = call.getString("url")
        if (urlStr == null) {
            call.reject("no url")
            return
        }
        val socksPort = call.getInt("socksPort") ?: 0
        if (socksPort <= 0) {
            call.reject("Tor is not ready")
            return
        }
        val accept = call.getString("accept") ?: "*/*"
        val maxBytes = call.getInt("maxBytes") ?: (8 * 1024 * 1024)

        // Off the calling thread: this opens sockets and blocks on the network.
        Thread {
            try {
                call.resolve(fetch(urlStr, socksPort, accept, maxBytes))
            } catch (e: Exception) {
                call.reject(e.message ?: "fetch failed")
            }
        }.start()
    }

    private fun fetch(urlStr: String, socksPort: Int, accept: String, maxBytes: Int): JSObject {
        val url = URL(urlStr)
        if (url.protocol != "https") throw IOException("only https is fetched")
        val host = url.host
        val port = if (url.port > 0) url.port else 443
        val path = (if (url.path.isNullOrEmpty()) "/" else url.path) +
            (if (url.query != null) "?" + url.query else "")

        val raw = Socket()
        try {
            // Loopback to Tor's SOCKS port. Tor itself is the only thing
            // listening there; nothing about this leaves the device in the clear.
            raw.connect(InetSocketAddress("127.0.0.1", socksPort), 30000)
            raw.soTimeout = 45000

            val sin = raw.getInputStream()
            val sout = raw.getOutputStream()

            // SOCKS5, no authentication.
            sout.write(byteArrayOf(0x05, 0x01, 0x00))
            sout.flush()
            val greeting = ByteArray(2)
            readFully(sin, greeting)
            if (greeting[0].toInt() != 0x05 || greeting[1].toInt() != 0x00) {
                throw IOException("SOCKS greeting refused")
            }

            // CONNECT, addressed by DOMAIN NAME (ATYP 0x03) so Tor resolves it —
            // the device never does a DNS lookup for the previewed host.
            val hb = host.toByteArray(Charsets.US_ASCII)
            if (hb.size > 255) throw IOException("host too long")
            val req = ByteArrayOutputStream()
            req.write(byteArrayOf(0x05, 0x01, 0x00, 0x03))
            req.write(hb.size)
            req.write(hb)
            req.write((port ushr 8) and 0xff)
            req.write(port and 0xff)
            sout.write(req.toByteArray())
            sout.flush()

            // Reply: VER REP RSV ATYP, then a bound address and port we discard.
            val head = ByteArray(4)
            readFully(sin, head)
            if (head[1].toInt() != 0x00) {
                throw IOException("SOCKS connect failed (code ${head[1].toInt() and 0xff})")
            }
            val bound = when (head[3].toInt() and 0xff) {
                0x01 -> 4
                0x04 -> 16
                0x03 -> {
                    val len = ByteArray(1)
                    readFully(sin, len)
                    len[0].toInt() and 0xff
                }
                else -> throw IOException("bad SOCKS address type")
            }
            readFully(sin, ByteArray(bound))
            readFully(sin, ByteArray(2))

            // TLS end-to-end over the tunnel, with SNI so shared-IP CDNs answer.
            val factory = SSLSocketFactory.getDefault() as SSLSocketFactory
            val tls = factory.createSocket(raw, host, port, true) as SSLSocket
            try {
                val params = tls.sslParameters
                params.serverNames = listOf(SNIHostName(host))
                tls.sslParameters = params
            } catch (_: Exception) {
                // Older platforms without SNIHostName still connect; a CDN that
                // needs SNI simply won't answer, which surfaces as a failed read.
            }
            tls.soTimeout = 45000
            tls.startHandshake()

            val out = tls.outputStream
            val inp = tls.inputStream

            // No cookies, no referrer: look like any other client behind an exit.
            val request =
                "GET $path HTTP/1.1\r\n" +
                    "Host: $host\r\n" +
                    "User-Agent: Mozilla/5.0\r\n" +
                    "Accept: $accept\r\n" +
                    "Accept-Encoding: identity\r\n" +
                    "Connection: close\r\n\r\n"
            out.write(request.toByteArray(Charsets.US_ASCII))
            out.flush()

            val buf = ByteArrayOutputStream()
            val tmp = ByteArray(16384)
            var total = 0
            var truncated = false
            while (true) {
                val n = inp.read(tmp)
                if (n < 0) break
                buf.write(tmp, 0, n)
                total += n
                // Counted as it arrives rather than trusting Content-Length,
                // which the server chooses and can lie about.
                if (total > maxBytes) {
                    truncated = true
                    break
                }
            }
            tls.close()

            val bytes = buf.toByteArray()
            val split = indexOfHeaderEnd(bytes)
            if (split < 0) throw IOException("no response")

            val headerText = String(bytes, 0, split, Charsets.ISO_8859_1)
            val lines = headerText.split("\r\n")
            val statusLine = lines.firstOrNull() ?: ""
            val status = statusLine.split(" ").getOrNull(1)?.toIntOrNull() ?: 0

            fun header(name: String): String? {
                val prefix = "$name:"
                return lines.drop(1)
                    .firstOrNull { it.length >= prefix.length && it.substring(0, prefix.length).equals(prefix, true) }
                    ?.substring(prefix.length)
                    ?.trim()
            }

            val body = bytes.copyOfRange(split + 4, bytes.size)

            val ret = JSObject()
            ret.put("status", status)
            header("content-type")?.let { ret.put("type", it) }
            header("location")?.let { ret.put("location", it) }
            ret.put("truncated", truncated)
            ret.put("body", Base64.encodeToString(body, Base64.NO_WRAP))
            return ret
        } finally {
            try { raw.close() } catch (_: Exception) {}
        }
    }

    private fun readFully(inp: InputStream, into: ByteArray) {
        var off = 0
        while (off < into.size) {
            val n = inp.read(into, off, into.size - off)
            if (n < 0) throw IOException("connection closed early")
            off += n
        }
    }

    /** Index of the CRLFCRLF that separates headers from body, or -1. */
    private fun indexOfHeaderEnd(b: ByteArray): Int {
        var i = 0
        while (i + 3 < b.size) {
            if (b[i].toInt() == 0x0d && b[i + 1].toInt() == 0x0a &&
                b[i + 2].toInt() == 0x0d && b[i + 3].toInt() == 0x0a
            ) return i
            i++
        }
        return -1
    }
}
