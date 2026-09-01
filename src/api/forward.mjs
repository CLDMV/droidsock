/**
 *	@Project: @cldmv/droidsock
 *	@Filename: /src/api/forward.mjs
 *	@Date: 2026-09-01 12:20:00 -07:00 (1788290400)
 *	@Author: Nate Hyson <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Hyson <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-09-01 12:20:00 -07:00 (1788290400)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 */

/**
 * Port forwarding API module for DroidSock (adb forward equivalent)
 */

import net from "node:net";

/**
 * Starts forwarding a local TCP port to a port on the device - the
 * `adb forward tcp:<localPort> tcp:<devicePort>` equivalent. Each connection
 * accepted on the local port opens a new ADB stream to the device's
 * `tcp:<devicePort>` service (the same client-initiated stream-open
 * mechanism already used for `shell:`/`sync:`) and bridges bytes
 * bidirectionally between the two until either side closes.
 * EXPERIMENTAL - the `tcp:` stream mechanism is implemented from the ADB
 * protocol spec, not yet validated against a real device. See #2.
 * @param {Object} ___socket - ADB socket (unused - streams are opened via streamManager)
 * @param {Object} streamManager - Stream manager instance
 * @param {number} devicePort - Device port to forward to
 * @param {Object} [options={}] - Options
 * @param {number} [options.localPort=0] - Local TCP port to listen on (0 picks a free port)
 * @param {string} [options.host="127.0.0.1"] - Local host to bind
 * @param {Function} [options.onError] - Called with (error, localSocket) on a per-connection bridging error
 * @returns {Promise<{localPort: number, close: () => Promise<void>}>} Control handle - `localPort` is the actual bound port, `close()` stops listening
 */
export async function start(___socket, streamManager, devicePort, options = {}) {
	const { localPort = 0, host = "127.0.0.1", onError } = options;

	const server = net.createServer((localSocket) => {
		// Attach this before awaiting openStream() below - otherwise a client
		// reset/abort that arrives while the stream is still opening has no
		// "error" listener yet, and Node emits an unhandled "error" event that
		// crashes the process. One handler covers both the pre- and
		// post-stream-open cases: `stream` is closed only once it exists.
		let stream;
		let localSocketFailed = false;
		localSocket.on("error", (error) => {
			localSocketFailed = true;
			if (stream) stream.close();
			if (onError) onError(error, localSocket);
		});

		(async () => {
			try {
				stream = await streamManager.openStream(`tcp:${devicePort}`);
			} catch (error) {
				localSocket.destroy();
				if (onError) onError(error, localSocket);
				return;
			}

			if (localSocketFailed || localSocket.destroyed) {
				stream.close();
				return;
			}

			stream.on("data", (data) => localSocket.write(data));
			stream.on("close", () => localSocket.end());
			stream.on("error", (error) => {
				stream.close();
				localSocket.destroy();
				if (onError) onError(error, localSocket);
			});

			localSocket.on("data", (data) => {
				stream.write(data).catch((error) => {
					// Forwarding can no longer proceed - tear down both sides rather
					// than leaving the local socket open to keep failing the same way.
					stream.close();
					localSocket.destroy();
					if (onError) onError(error, localSocket);
				});
			});
			localSocket.on("close", () => stream.close());
		})();
	});

	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(localPort, host, () => {
			server.removeListener("error", reject);
			resolve();
		});
	});

	return {
		localPort: server.address().port,
		close() {
			return new Promise((resolve) => server.close(() => resolve()));
		}
	};
}
