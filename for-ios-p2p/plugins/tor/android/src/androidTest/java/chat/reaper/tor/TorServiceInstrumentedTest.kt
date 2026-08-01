package chat.reaper.tor

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.getcapacitor.JSObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * Starts the real vendored tor binary and waits for it to actually reach the
 * Tor network — bootstrap a circuit and publish a hidden-service descriptor —
 * on the emulator's real (NAT'd) internet connection. Nothing here is mocked;
 * the point is proving `TorService` can drive the binary Gradle packages, not
 * just that the Kotlin compiles.
 */
@RunWith(AndroidJUnit4::class)
class TorServiceInstrumentedTest {

    @Test
    fun startsAndPublishesOnionAddress() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val events = ArrayBlockingQueue<Pair<String, JSObject>>(64)
        val tor = TorService(context) { state, detail -> events.put(state to detail) }

        // A throwaway forwarding target — this test only cares that tor
        // bootstraps and publishes, not that anything is listening behind it.
        tor.start(41111, 0, true)

        var readyPort = 0
        var published: String? = null
        val deadline = System.currentTimeMillis() + 150_000

        while (System.currentTimeMillis() < deadline && (readyPort == 0 || published == null)) {
            val e = events.poll(5, TimeUnit.SECONDS) ?: continue
            when (e.first) {
                "ready" -> readyPort = e.second.optInt("socksPort", 0)
                "published" -> published = e.second.optString("onion").takeIf { it.isNotEmpty() }
                "failed" -> fail("tor reported a failure: ${e.second.optString("error")}")
            }
        }

        assertTrue("tor never reported its SOCKS port ready within 150s", readyPort > 0)
        assertNotNull("tor never published an onion address within 150s", published)
        val address = published!!
        assertTrue("'$address' does not look like a v3 onion address", address.endsWith(".onion"))
        assertEquals(62, address.length)

        tor.stop()
    }
}
