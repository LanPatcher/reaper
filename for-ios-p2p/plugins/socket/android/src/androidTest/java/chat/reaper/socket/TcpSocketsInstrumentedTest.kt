package chat.reaper.socket

import android.util.Base64
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.getcapacitor.JSObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.DataInputStream
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * Exercises `TcpSockets` against real sockets rather than mocks — the
 * behavior this class exists for (loopback listen/accept, and the hand-rolled
 * SOCKS5 client) only means anything proven against an actual socket.
 */
@RunWith(AndroidJUnit4::class)
class TcpSocketsInstrumentedTest {

    private data class Event(val id: String, val name: String, val payload: JSObject)

    @Test
    fun listenAndAcceptRoundTrip() {
        val events = ArrayBlockingQueue<Event>(32)
        val sockets = TcpSockets { id, event, payload -> events.put(Event(id, event, payload)) }

        val boundPort = bindAndAwait(sockets, 0)
        assertTrue(boundPort > 0)
        assertEquals(listOf(boundPort), sockets.listeningPorts())

        // A raw client, the way Tor forwards a connection to this listener.
        val client = Socket("127.0.0.1", boundPort)

        val accept = takeEvent(events, "accept")
        val serverSideId = accept.id
        assertEquals(boundPort, accept.payload.getInt("port"))

        // client -> server
        client.getOutputStream().write("ping".toByteArray())
        client.getOutputStream().flush()
        val fromClient = takeEvent(events, "data")
        assertEquals(serverSideId, fromClient.id)
        assertEquals("ping", String(Base64.decode(fromClient.payload.getString("data"), Base64.DEFAULT)))

        // server -> client
        sockets.send(serverSideId, "pong".toByteArray())
        val fromServer = ByteArray(4)
        DataInputStream(client.getInputStream()).readFully(fromServer)
        assertEquals("pong", String(fromServer))

        client.close()
        sockets.closeAll()
    }

    @Test
    fun socks5HandshakeRoundTrip() {
        // A minimal fake SOCKS5 proxy: acks the greeting and the CONNECT,
        // then echoes whatever arrives after — enough to run TcpSockets'
        // hand-rolled client against a real socket rather than a mock.
        val proxy = ServerSocket(0)
        val proxyPort = proxy.localPort

        val proxyThread = Thread {
            val conn = proxy.accept()
            val input = DataInputStream(conn.getInputStream())
            val output = conn.getOutputStream()

            val greeting = ByteArray(3)
            input.readFully(greeting)
            assertArrayEquals(byteArrayOf(0x05, 0x01, 0x00), greeting)
            output.write(byteArrayOf(0x05, 0x00))
            output.flush()

            val head = ByteArray(5)
            input.readFully(head)
            assertEquals(0x05, head[0].toInt())
            assertEquals(0x03, head[3].toInt())
            val nameLen = head[4].toInt() and 0xff
            val rest = ByteArray(nameLen + 2)
            input.readFully(rest)
            assertEquals("test.onion", String(rest, 0, nameLen))

            // success reply: ver, ok, rsv, IPv4 addr-type, 4+2 zero bytes
            output.write(byteArrayOf(0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0))
            output.flush()

            val buf = ByteArray(4096)
            while (true) {
                val n = try { input.read(buf) } catch (e: Exception) { -1 }
                if (n <= 0) break
                output.write(buf, 0, n)
                output.flush()
            }
        }
        proxyThread.isDaemon = true
        proxyThread.start()

        val events = ArrayBlockingQueue<Event>(32)
        val sockets = TcpSockets { id, event, payload -> events.put(Event(id, event, payload)) }

        sockets.connect("out-1", "test.onion", 1234, proxyPort)
        val connected = takeEvent(events, "connect")
        assertEquals("out-1", connected.id)

        sockets.send("out-1", "hello".toByteArray())
        val echoed = takeEvent(events, "data")
        assertEquals("out-1", echoed.id)
        assertEquals("hello", String(Base64.decode(echoed.payload.getString("data"), Base64.DEFAULT)))

        sockets.close("out-1")
        proxy.close()
    }

    private fun bindAndAwait(sockets: TcpSockets, port: Int): Int {
        val result = ArrayBlockingQueue<Result<Int>>(1)
        sockets.listen(port) { result.put(it) }
        return result.poll(5, TimeUnit.SECONDS)!!.getOrThrow()
    }

    private fun takeEvent(events: ArrayBlockingQueue<Event>, name: String): Event {
        val e = events.poll(5, TimeUnit.SECONDS)
        assertNotNull("timed out waiting for '$name'", e)
        assertEquals(name, e!!.name)
        return e
    }
}
