/**
 *	@Project: @cldmv/droidsock
 *	@Filename: /src/api/reverse.mjs
 *	@Date: 2026-09-03 12:00:00 -07:00 (1788375600)
 *	@Author: Nate Hyson <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Hyson <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-09-03 12:00:00 -07:00 (1788375600)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 */

/**
 * Reverse port forwarding API module for DroidSock (adb reverse equivalent)
 */

import net from "node:net";

/**
 * Parses a classic ADB host-service ack from a `WRTE` payload - the literal
 * 4 bytes `"OKAY"` for success, or `"FAIL"` followed by a 4-hex-digit length
 * and a message for failure (the same convention every `host:`/`reverse:`
 * command-response service uses). Throws with the failure message when the
 * ack is a FAIL, or when it's neither.
 * @param {Buffer} ack - The ack payload.
 * @param {string} action - Human-readable description of what was being acked, for the error message.
 * @returns {void}
 */
function assertOkayAck(ack, action) {
	const id = ack.toString("ascii", 0, 4);
	if (id === "OKAY") return;
	if (id === "FAIL") {
		// The 4-hex-digit length field must itself be validated, not just
		// parsed optimistically - a malformed field (not valid hex) previously
		// fell through `parseInt(...) || 0`, since parseInt() returns NaN for
		// non-hex input and `NaN || 0` silently treats corrupted data as a
		// valid zero-length message instead of surfacing a protocol error.
		const lengthField = ack.toString("ascii", 4, 8);
		if (!/^[0-9a-fA-F]{4}$/.test(lengthField)) {
			throw new Error(`Unexpected response to ${action}: ${ack.toString("utf8")}`);
		}
		const messageLength = parseInt(lengthField, 16);
		const message = ack.subarray(8, 8 + messageLength).toString("utf8");
		throw new Error(`Failed to ${action}: ${message}`);
	}
	throw new Error(`Unexpected response to ${action}: ${ack.toString("utf8")}`);
}

/**
 * Starts reverse port forwarding - the `adb reverse tcp:<devicePort>
 * tcp:<hostPort>` equivalent. Registers the tunnel with the device (a normal
 * client-initiated `reverse:forward:` stream, acked the same way every ADB
 * host-service is), then bridges every subsequent device-initiated
 * connection tagged for this mapping to a fresh local TCP connection.
 * EXPERIMENTAL - built from the ADB protocol spec, not yet validated against
 * a real device. See #1.
 * @param {Object} ___socket - ADB socket (unused - streams are opened via streamManager)
 * @param {Object} streamManager - Stream manager instance
 * @param {number} devicePort - Device port to register the reverse tunnel on
 * @param {number} hostPort - Local port to connect to for each device-initiated connection
 * @param {Object} [options={}] - Options
 * @param {string} [options.host="127.0.0.1"] - Local host to connect to
 * @param {Function} [options.onError] - Called with (error, deviceStream) on a per-connection bridging error
 * @returns {Promise<{devicePort: number, hostPort: number, close: () => Promise<void>}>} Control handle - `close()` unregisters the tunnel and stops bridging
 */
export async function start(___socket, streamManager, devicePort, hostPort, options = {}) {
	const { host = "127.0.0.1", onError } = options;
	const destination = `tcp:${hostPort}`;

	// Attached before the registration round-trip completes: a compliant
	// device could route a connection the moment it's registered, which may
	// race the OKAY ack for the registration stream itself reaching us.
	const onRemoteOpen = (deviceStream, streamDestination) => {
		// Every reverse() call on this connection shares one manager-wide
		// "remoteOpen" event - only bridge connections tagged for THIS
		// mapping's hostPort; another reverse() call owns anything else.
		if (streamDestination !== destination) return;

		const localSocket = net.connect(hostPort, host);
		let localSocketFailed = false;
		let localSocketConnected = false;
		// The device already received the OKAY for this stream (sent
		// synchronously before "remoteOpen" fires) and may write to it before
		// this local TCP connect completes. AdbStream is a plain EventEmitter
		// with no buffering, so a "data" listener attached only inside the
		// "connect" callback below would silently drop anything the device
		// sent in that window - attach listeners immediately instead, and
		// queue device->host bytes until the local socket is actually up.
		const pendingDeviceData = [];

		// streamManager.closeStream() (not deviceStream.close()) so the stream
		// manager also drops its registry entry - same pattern as
		// registerStream/killStream below and reboot.mjs's execute(). Both
		// closeStream() and AdbStream.close() are idempotent, so it's safe to
		// call this from more than one teardown path for the same stream.
		const closeDeviceStream = () => streamManager.closeStream(deviceStream.localId);

		deviceStream.on("data", (data) => {
			// A device WRTE can still be in flight (or arrive before our CLSE
			// reaches the device) after the local socket has already errored -
			// localSocketConnected alone doesn't reflect that, so writing here
			// would target an already-destroyed socket. Drop the data instead
			// of also buffering it: the local target is gone, so nothing will
			// ever flush pendingDeviceData for it anyway.
			if (localSocketFailed) return;
			if (localSocketConnected) {
				localSocket.write(data);
			} else {
				pendingDeviceData.push(data);
			}
		});
		deviceStream.on("close", () => {
			closeDeviceStream();
			if (localSocketConnected) localSocket.end();
			else localSocket.destroy();
		});
		deviceStream.on("error", (error) => {
			closeDeviceStream();
			localSocket.destroy();
			if (onError) onError(error, deviceStream);
		});

		localSocket.on("error", (error) => {
			localSocketFailed = true;
			localSocket.destroy();
			closeDeviceStream();
			if (onError) onError(error, deviceStream);
		});

		localSocket.on("connect", () => {
			if (localSocketFailed || deviceStream.closed) {
				localSocket.destroy();
				return;
			}

			localSocketConnected = true;
			for (const data of pendingDeviceData) localSocket.write(data);
			pendingDeviceData.length = 0;

			localSocket.on("data", (data) => {
				deviceStream.write(data).catch((error) => {
					closeDeviceStream();
					localSocket.destroy();
					if (onError) onError(error, deviceStream);
				});
			});
			localSocket.on("close", () => closeDeviceStream());
		});
	};
	streamManager.on("remoteOpen", onRemoteOpen);

	let registerStream;
	try {
		registerStream = await streamManager.openStream(`reverse:forward:tcp:${devicePort};tcp:${hostPort}`);
		const ack = await new Promise((resolve, reject) => {
			registerStream.once("data", resolve);
			registerStream.once("error", reject);
			registerStream.once("close", () => reject(new Error("reverse registration stream closed with no ack")));
		});
		assertOkayAck(ack, `register reverse tunnel tcp:${devicePort} -> tcp:${hostPort}`);
	} catch (error) {
		streamManager.off("remoteOpen", onRemoteOpen);
		throw error;
	} finally {
		// closeStream() (not stream.close()) so the stream manager also drops
		// its registry entry - see reboot.mjs's execute() for the same
		// pattern and rationale.
		if (registerStream) streamManager.closeStream(registerStream.localId);
	}

	return {
		devicePort,
		hostPort,
		async close() {
			streamManager.off("remoteOpen", onRemoteOpen);

			// Best-effort: unregister the tunnel so the device stops routing
			// connections here. A connection that's already gone (or a device
			// that never re-acks a killforward) shouldn't block teardown.
			let killStream;
			try {
				killStream = await streamManager.openStream(`reverse:killforward:tcp:${devicePort}`);
				const ack = await new Promise((resolve, reject) => {
					killStream.once("data", resolve);
					killStream.once("error", reject);
					killStream.once("close", () => reject(new Error("reverse killforward stream closed with no ack")));
				});
				assertOkayAck(ack, `unregister reverse tunnel tcp:${devicePort}`);
			} catch {
				// Non-fatal - see comment above.
			} finally {
				// closeStream() (not stream.close()) so the stream manager also
				// drops its registry entry, regardless of which step above
				// failed - see reboot.mjs's execute() for the same pattern.
				if (killStream) streamManager.closeStream(killStream.localId);
			}
		}
	};
}
