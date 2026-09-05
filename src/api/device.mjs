/**
 *	@Project: @cldmv/droidsock
 *	@Filename: /src/api/device.mjs
 *	@Date: 2025-11-21 12:18:12 -08:00 (1763756292)
 *	@Author: Nate Hyson <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Hyson <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-08-30 16:02:20 -07:00 (1788130940)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 */

/**
 * Single-device connection API module for DroidSock.
 *
 * connect()/disconnect()/remove() are the single-target operations - the
 * module name disambiguates them from the collection-wide operations on
 * self.devices (list/disconnect/remove/get, see devices.mjs).
 *
 * A device leaf, once created, is a persistent handle that outlives any one
 * TCP connection: disconnect() only tears down the current socket (cheap,
 * synchronous - there's no api-tree work left to do), it does NOT unmount
 * the leaf. connect() on an already-known (but disconnected) host:port
 * reconnects that SAME leaf in place - reusing its remembered options
 * (see reconnect() below) - rather than building a new one, so a reference
 * you're already holding (or a caller looking it up later via devices.get())
 * stays valid across a disconnect/reconnect cycle. remove() is the separate,
 * explicit "forget this device" operation - it disconnects (if needed) and
 * unmounts the leaf, which IS real api-tree surgery and therefore the one
 * genuinely async step in this lifecycle.
 *
 * Every connected-or-previously-connected device lives on this module's own
 * slothlet namespace (self.devices / api.devices) as a real,
 * individually-addressable leaf (mounted via api.slothlet.api.add(),
 * docs/RELOAD.md) - only the module that starts/ends/forgets a single
 * connection lives here; the leaf itself is always reachable at
 * `devices.<sanitized host_port>` regardless of which module mounted,
 * disconnected, or removed it. self access inside a device's methods works
 * correctly on every call because they're genuine tree leaves invoked
 * through the normal apply-trap path - unlike a plain object returned from an
 * async function (which depends on slothlet's class-instance
 * context-preservation mechanism, and that mechanism never actually fires
 * for an async function's return value - see the linked issue below), and
 * unlike a plain `self.devices[key] = <object>` assignment (slothlet's
 * documented "wrap-on-set" behavior, CONTEXT-PROPAGATION.md - empirically
 * this does NOT give the assigned object's methods working self access the
 * way add() does, despite the doc describing it as using "the same wrapper
 * construction").
 */

import { self } from "@cldmv/slothlet/runtime";
import { quoteShellArg, sanitizeKey } from "./utils.mjs";

/**
 * Establishes one TCP connection + stream manager for a device and wires up
 * packet routing - the actual protocol-level work shared by both the first
 * connect() and every later reconnect() of the same leaf.
 * @param {string} host - Device host/IP address
 * @param {number} port - Device port
 * @param {Object} options - Connection options
 * @param {string} [options.keyDir] - Directory for RSA keys (default: ~/.adb)
 * @returns {Promise<{connection: Object, streamManager: Object}>} The new session pair.
 */
async function openSession(host, port, options) {
	const keys = await self.auth.getKeys(options.keyDir);
	const connection = await self.connection.create({
		host,
		port,
		publicKey: keys.publicKey,
		privateKey: keys.privateKey,
		adbPublicKey: keys.adbPublicKey
	});
	const streamManager = await self.stream.create(connection.socket);
	connection.onUnhandledPacket = (packet) => streamManager.handlePacket(packet);
	return { connection, streamManager };
}

/**
 * Builds the per-device leaf object assigned onto self.devices[key]. Every
 * function here becomes a real, individually-wrapped slothlet leaf once
 * assigned - see the module doc comment above.
 *
 * Every method reads the connection/stream manager off `session` - a plain
 * object private to this closure, never passed through add()'s flatten+wrap
 * pipeline - rather than off a data property of the mounted leaf itself.
 * That indirection is required, not stylistic: slothlet's mount pipeline
 * does not preserve object identity between the raw object passed to add()
 * and what self.devices[deviceKey] resolves to afterward (functions ARE
 * correctly proxied through to their real closures either way - only a
 * plain-data-property write/read through the wrapper is unreliable). So a
 * write to `self.devices[deviceKey].connection` would never be visible to a
 * closure that reads `leaf.connection` - it has to read a value that was
 * never touched by that pipeline at all. `leaf.connection`/
 * `leaf.streamManager` still exist as a best-effort EXTERNAL mirror (for
 * callers/tests that read `device.connection.socket`, per docs/API.md), but
 * nothing in this file relies on them internally - reconnect() is the only
 * place that writes them, and it does so through `self.devices[deviceKey]`
 * specifically (see its comment) rather than through `leaf` directly.
 * @param {string} host - Device host/IP address
 * @param {number} port - Device port
 * @param {string} deviceId - `${host}:${port}`
 * @param {string} deviceKey - Sanitized api-path segment for this device
 * @param {Object} options - The connect() options this leaf was created with, remembered for reconnect().
 * @returns {Object} The device leaf
 */
function buildDeviceLeaf(host, port, deviceId, deviceKey, options) {
	const session = { connection: null, streamManager: null };

	/**
	 * Throws if this device isn't connected and authorized. Shared guard for every method below.
	 */
	function assertReady() {
		if (!leaf.isConnected()) {
			throw new Error("Device not connected");
		}
		if (!session.connection.authorized) {
			throw new Error("Device not authorized. Please accept authorization dialog.");
		}
	}

	const leaf = {
		host,
		port,
		deviceId,
		options,
		connection: null,
		streamManager: null,

		// session.connection.connected is only ever set false by disconnect() -
		// nothing updates it if the underlying TCP socket dies unexpectedly
		// (device unplugged, network drop), so it can go stale and keep
		// reporting connected. socket.destroyed is live, authoritative state
		// regardless of why the socket went away, so check it directly rather
		// than trusting the flag alone - connect()'s reuse-vs-reconnect
		// decision, and every assertReady() call, depend entirely on this
		// being accurate.
		isConnected: () =>
			Boolean(session.connection && session.connection.connected && session.connection.socket && !session.connection.socket.destroyed),

		// Tears down the current socket only - the leaf stays mounted at
		// api.devices.<key> so it can be reconnected later without needing to
		// re-supply host/port/options. No api-tree work happens here, so
		// unlike remove() this needs no await at all.
		disconnect: () => {
			if (session.connection) session.connection.disconnect();
		},

		// (Re)establishes the underlying connection for this SAME leaf - used
		// by connect() (both for the very first connection and for a caller
		// asking to connect a host:port that's already mounted but currently
		// disconnected). A no-op if already connected (mirrors connect()'s own
		// dedupe, rather than forcing a healthy connection to bounce).
		// reconnectOptions overrides only the fields it provides; anything
		// omitted falls back to what this leaf was created (or last
		// reconnected) with.
		reconnect: async (reconnectOptions = {}) => {
			// Always resolve and return self.devices[deviceKey] - the same
			// externally-visible reference every connect()/get() call hands
			// out - rather than the internal `leaf` closure variable itself.
			// The two are NOT interchangeable: see this function's own doc
			// comment above for why a plain-data write is only reliable
			// through the mounted reference, and returning `leaf` directly
			// here would silently hand back a second, divergent "device"
			// object with none of that reference's mirrored state.
			// Merge/remember the new options BEFORE the already-connected
			// short-circuit below - otherwise options passed while already
			// connected would be silently discarded instead of taking effect
			// on the NEXT reconnect, contradicting this function's own "falls
			// back to what this leaf was created (or last reconnected) with"
			// contract.
			leaf.options = { ...leaf.options, ...reconnectOptions };
			if (leaf.isConnected()) return self.devices[deviceKey];
			const { connection, streamManager } = await openSession(host, port, leaf.options);
			session.connection = connection;
			session.streamManager = streamManager;
			self.devices[deviceKey].connection = connection;
			self.devices[deviceKey].streamManager = streamManager;
			return self.devices[deviceKey];
		},

		// The explicit "forget this device" operation - disconnects if still
		// connected, then unmounts the leaf. This is the one genuinely async
		// step in the lifecycle, since it's real api-tree surgery
		// (api.slothlet.api.remove()), unlike disconnect() above.
		remove: async () => {
			leaf.disconnect();
			// Best-effort - an already-removed entry (e.g. a repeated remove()
			// call) would otherwise throw here and mask that the socket was
			// already torn down above.
			await self.slothlet.api.remove(`devices.${deviceKey}`).catch(() => {});
		},

		shell: async (command, shellOptions = {}) => {
			assertReady();
			return await self.shell.execute(session.connection.socket, session.streamManager, command, {
				...shellOptions,
				deviceFeatures: session.connection.deviceFeatures || []
			});
		},

		startStreamingShell: (command, shellOptions = {}) => {
			assertReady();
			return self.shell.startStreaming(session.connection.socket, session.streamManager, command, shellOptions);
		},

		startInteractiveShell: (command, shellOptions = {}) => {
			assertReady();
			return self.shell.startInteractive(session.connection.socket, session.streamManager, command, shellOptions);
		},

		push: async (localPath, remotePath, transferOptions = {}) => {
			assertReady();
			return await self.files.push(session.connection.socket, session.streamManager, localPath, remotePath, transferOptions);
		},

		pull: async (remotePath, localPath, transferOptions = {}) => {
			assertReady();
			return await self.files.pull(session.connection.socket, session.streamManager, remotePath, localPath, transferOptions);
		},

		// SYNC V2 (64-bit) variants - see self.files.pushV2/pullV2 for the
		// wire-level rationale. EXPERIMENTAL, same caveats as push/pull.
		pushV2: async (localPath, remotePath, transferOptions = {}) => {
			assertReady();
			return await self.files.pushV2(session.connection.socket, session.streamManager, localPath, remotePath, transferOptions);
		},

		pullV2: async (remotePath, localPath, transferOptions = {}) => {
			assertReady();
			return await self.files.pullV2(session.connection.socket, session.streamManager, remotePath, localPath, transferOptions);
		},

		list: async (remotePath) => {
			assertReady();
			return await self.files.list(session.connection.socket, session.streamManager, remotePath);
		},

		stat: async (remotePath) => {
			assertReady();
			return await self.files.stat(session.connection.socket, session.streamManager, remotePath);
		},

		listV2: async (remotePath) => {
			assertReady();
			return await self.files.listV2(session.connection.socket, session.streamManager, remotePath);
		},

		statV2: async (remotePath) => {
			assertReady();
			return await self.files.statV2(session.connection.socket, session.streamManager, remotePath);
		},

		// Reboot (real ADB `reboot:` service - see also the shell-based
		// `device.shell("reboot")` fallback, kept for compatibility)
		reboot: async (mode = "") => {
			assertReady();
			return await self.reboot.execute(session.connection.socket, session.streamManager, mode);
		},

		// Port forwarding (adb forward equivalent) - see also self.forward
		forward: async (devicePort, forwardOptions = {}) => {
			assertReady();
			return await self.forward.start(session.connection.socket, session.streamManager, devicePort, forwardOptions);
		},

		// Reverse port forwarding (adb reverse equivalent) - see also self.reverse
		reverse: async (devicePort, hostPort, reverseOptions = {}) => {
			assertReady();
			return await self.reverse.start(session.connection.socket, session.streamManager, devicePort, hostPort, reverseOptions);
		},

		// Local APK install (adb install equivalent). Tries the modern streaming
		// install (self.install.streaming) when the device advertised the "cmd"
		// feature during the CNXN handshake, falling back to the classic
		// push-then-install flow (self.install.classic) otherwise, or if the
		// streaming attempt itself fails partway through (e.g. a device that
		// advertises "cmd" but doesn't actually support `cmd package install`).
		install: async (localPath, installOptions = {}) => {
			assertReady();
			if ((session.connection.deviceFeatures || []).includes("cmd")) {
				try {
					return await self.install.streaming(session.connection.socket, session.streamManager, localPath, installOptions);
				} catch (streamingError) {
					// Fall through to the classic push-then-install flow - but if
					// that ALSO fails, surface the original streaming failure
					// alongside it. Discarding streamingError unconditionally
					// would lose the real cause whenever classic fails too (the
					// caller would only ever see the classic error).
					try {
						return await self.install.classic(session.connection.socket, session.streamManager, localPath, installOptions);
					} catch (classicError) {
						throw new Error(
							`Streaming install failed (${streamingError.message}), and the classic fallback also failed: ${classicError.message}`,
							{ cause: classicError }
						);
					}
				}
			}
			return await self.install.classic(session.connection.socket, session.streamManager, localPath, installOptions);
		},

		// Convenience shell shortcuts
		ls: (path = ".") => leaf.shell(`ls -la ${quoteShellArg(path)}`),
		pwd: () => leaf.shell("pwd"),
		getprop: (prop = null) => leaf.shell(prop ? `getprop ${quoteShellArg(prop)}` : "getprop"),
		getModel: () => leaf.shell("getprop ro.product.model"),
		getAndroidVersion: () => leaf.shell("getprop ro.build.version.release"),
		getBattery: () => leaf.shell("dumpsys battery"),
		screenshot: (filename = "/sdcard/screenshot.png") => leaf.shell(`screencap -p ${quoteShellArg(filename)}`),
		logcat: (logOptions = {}) => leaf.startStreamingShell("logcat", logOptions),
		top: (topOptions = {}) => leaf.startStreamingShell("top -m 10", topOptions),
		keypress: (key) => leaf.shell(`input keyevent ${quoteShellArg(key)}`),
		launchApp: (packageName, activity = "") => {
			// package/activity must reach `am start -n` as a single argument (a
			// single "/"-joined token), so the combined value is quoted as one
			// unit rather than quoting packageName and activity separately.
			const target = activity ? `${packageName}/${activity}` : packageName;
			return leaf.shell(`am start -n ${quoteShellArg(target)}`);
		},
		rebootBootloader: () => leaf.reboot("bootloader"),
		rebootRecovery: () => leaf.reboot("recovery"),
		rebootSideload: () => leaf.reboot("sideload")
	};

	return leaf;
}

/**
 * Connects to an ADB device. Registers the connection as a real leaf at
 * self.devices[key] (see the module doc comment above) and returns that
 * same leaf. Calling this again for a host:port that's already mounted
 * reuses the SAME leaf - reconnecting it in place if it had disconnected,
 * so a caller holding a prior reference (or resolving one later via
 * devices.get()) never has to re-supply host/port/options.
 * @param {string} host - Device host/IP address
 * @param {number} [port=5555] - Device port
 * @param {Object} [options={}] - Connection options
 * @param {string} [options.keyDir] - Directory for RSA keys (default: ~/.adb)
 * @returns {Promise<Object>} The device leaf (also reachable at api.devices.<sanitized host_port>)
 */
export async function connect(host, port = 5555, options = {}) {
	const deviceId = `${host}:${port}`;
	const deviceKey = sanitizeKey(deviceId);

	const existing = self.devices && self.devices[deviceKey];
	if (existing) {
		return await existing.reconnect(options);
	}

	// Mount first, with no connection/stream manager yet - add()'s
	// flatten+wrap pipeline hangs indefinitely when a real net.Socket
	// (deeply nested, self-referential internals) is present anywhere in its
	// input. reconnect() (called immediately below) is the single place that
	// actually opens the session and mirrors it onto the mounted leaf -
	// there's no separate first-connect path to keep in sync with it.
	const leaf = buildDeviceLeaf(host, port, deviceId, deviceKey, options);
	await self.slothlet.api.add(`devices.${deviceKey}`, leaf, { moduleID: `device:${deviceId}` });
	await self.devices[deviceKey].reconnect(options);

	return self.devices[deviceKey];
}

/**
 * Disconnects from a specific device without forgetting it - the leaf stays
 * mounted at api.devices.<key> so a later connect(host, port) reconnects it
 * in place. Synchronous: there's no api-tree work to await here (see
 * remove() for that).
 * @param {string} host - Device host
 * @param {number} [port=5555] - Device port
 * @returns {boolean} True if a device was found and disconnected
 */
export function disconnect(host, port = 5555) {
	const deviceKey = sanitizeKey(`${host}:${port}`);
	const entry = self.devices && self.devices[deviceKey];
	if (!entry) {
		return false;
	}
	entry.disconnect();
	return true;
}

/**
 * Forgets a specific device entirely - disconnects it if still connected,
 * then unmounts its leaf from api.devices. Use disconnect() instead if you
 * only want to tear down the connection while keeping the ability to
 * reconnect later without re-supplying host/port/options.
 * @param {string} host - Device host
 * @param {number} [port=5555] - Device port
 * @returns {Promise<boolean>} True if a device was found and removed
 */
export async function remove(host, port = 5555) {
	const deviceKey = sanitizeKey(`${host}:${port}`);
	const entry = self.devices && self.devices[deviceKey];
	if (!entry) {
		return false;
	}
	await entry.remove();
	return true;
}
