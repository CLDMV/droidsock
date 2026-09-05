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
 * connect()/disconnect() are the single-target operations - the module name
 * disambiguates them from the collection-wide operations on self.devices
 * (list/disconnect/get, see devices.mjs). A connected device still lives on
 * self.devices/api.devices as a real, individually-addressable leaf (mounted
 * via api.slothlet.api.add(), docs/RELOAD.md) - only the module that starts
 * or ends a single connection lives here; the leaf itself is always
 * reachable at `devices.<sanitized host_port>` regardless of which module
 * mounted or unmounted it. self access inside a device's methods
 * works correctly on every call because they're genuine tree leaves invoked
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
 * Builds the per-device leaf object assigned onto self.devices[key]. Every
 * function here becomes a real, individually-wrapped slothlet leaf once
 * assigned - see the module doc comment above.
 * @param {string} host - Device host/IP address
 * @param {number} port - Device port
 * @param {string} deviceId - `${host}:${port}`
 * @param {string} deviceKey - Sanitized api-path segment for this device
 * @param {Object} connection - The underlying connection object (see connection.mjs)
 * @param {Object} streamManager - The underlying stream manager (see stream.mjs)
 * @returns {Object} The device leaf
 */
function buildDeviceLeaf(host, port, deviceId, deviceKey, connection, streamManager) {
	/**
	 * Throws if this device isn't connected and authorized. Shared guard for every method below.
	 */
	function assertReady() {
		if (!leaf.isConnected()) {
			throw new Error("Device not connected");
		}
		if (!connection.authorized) {
			throw new Error("Device not authorized. Please accept authorization dialog.");
		}
	}

	const leaf = {
		host,
		port,
		deviceId,

		// connection.connected is only ever set false by disconnect() -
		// nothing updates it if the underlying TCP socket dies unexpectedly
		// (device unplugged, network drop), so it can go stale and keep
		// reporting connected. socket.destroyed is live, authoritative state
		// regardless of why the socket went away, so check it directly rather
		// than trusting the flag alone - connect()'s reuse-vs-reconnect
		// decision depends entirely on this being accurate.
		isConnected: () => Boolean(connection && connection.connected && connection.socket && !connection.socket.destroyed),

		// Closing the socket and detaching this leaf from the tree are both
		// this method's job - a device that's gone shouldn't leave a stale
		// api.devices.<key> entry behind.
		disconnect: async () => {
			if (connection) connection.disconnect();
			// Best-effort, like connect()'s own stale-entry removal - an already-
			// removed entry (e.g. a repeated disconnect() call) would otherwise
			// throw here and mask that the socket was already torn down above.
			await self.slothlet.api.remove(`devices.${deviceKey}`).catch(() => {});
		},

		shell: async (command, shellOptions = {}) => {
			assertReady();
			return await self.shell.execute(connection.socket, streamManager, command, {
				...shellOptions,
				deviceFeatures: connection.deviceFeatures || []
			});
		},

		startStreamingShell: (command, shellOptions = {}) => {
			assertReady();
			return self.shell.startStreaming(connection.socket, streamManager, command, shellOptions);
		},

		startInteractiveShell: (command, shellOptions = {}) => {
			assertReady();
			return self.shell.startInteractive(connection.socket, streamManager, command, shellOptions);
		},

		push: async (localPath, remotePath, transferOptions = {}) => {
			assertReady();
			return await self.files.push(connection.socket, streamManager, localPath, remotePath, transferOptions);
		},

		pull: async (remotePath, localPath, transferOptions = {}) => {
			assertReady();
			return await self.files.pull(connection.socket, streamManager, remotePath, localPath, transferOptions);
		},

		// SYNC V2 (64-bit) variants - see self.files.pushV2/pullV2 for the
		// wire-level rationale. EXPERIMENTAL, same caveats as push/pull.
		pushV2: async (localPath, remotePath, transferOptions = {}) => {
			assertReady();
			return await self.files.pushV2(connection.socket, streamManager, localPath, remotePath, transferOptions);
		},

		pullV2: async (remotePath, localPath, transferOptions = {}) => {
			assertReady();
			return await self.files.pullV2(connection.socket, streamManager, remotePath, localPath, transferOptions);
		},

		list: async (remotePath) => {
			assertReady();
			return await self.files.list(connection.socket, streamManager, remotePath);
		},

		stat: async (remotePath) => {
			assertReady();
			return await self.files.stat(connection.socket, streamManager, remotePath);
		},

		listV2: async (remotePath) => {
			assertReady();
			return await self.files.listV2(connection.socket, streamManager, remotePath);
		},

		statV2: async (remotePath) => {
			assertReady();
			return await self.files.statV2(connection.socket, streamManager, remotePath);
		},

		// Reboot (real ADB `reboot:` service - see also the shell-based
		// `device.shell("reboot")` fallback, kept for compatibility)
		reboot: async (mode = "") => {
			assertReady();
			return await self.reboot.execute(connection.socket, streamManager, mode);
		},

		// Port forwarding (adb forward equivalent) - see also self.forward
		forward: async (devicePort, forwardOptions = {}) => {
			assertReady();
			return await self.forward.start(connection.socket, streamManager, devicePort, forwardOptions);
		},

		// Reverse port forwarding (adb reverse equivalent) - see also self.reverse
		reverse: async (devicePort, hostPort, reverseOptions = {}) => {
			assertReady();
			return await self.reverse.start(connection.socket, streamManager, devicePort, hostPort, reverseOptions);
		},

		// Local APK install (adb install equivalent). Tries the modern streaming
		// install (self.install.streaming) when the device advertised the "cmd"
		// feature during the CNXN handshake, falling back to the classic
		// push-then-install flow (self.install.classic) otherwise, or if the
		// streaming attempt itself fails partway through (e.g. a device that
		// advertises "cmd" but doesn't actually support `cmd package install`).
		install: async (localPath, installOptions = {}) => {
			assertReady();
			if ((connection.deviceFeatures || []).includes("cmd")) {
				try {
					return await self.install.streaming(connection.socket, streamManager, localPath, installOptions);
				} catch (streamingError) {
					// Fall through to the classic push-then-install flow - but if
					// that ALSO fails, surface the original streaming failure
					// alongside it. Discarding streamingError unconditionally
					// would lose the real cause whenever classic fails too (the
					// caller would only ever see the classic error).
					try {
						return await self.install.classic(connection.socket, streamManager, localPath, installOptions);
					} catch (classicError) {
						throw new Error(
							`Streaming install failed (${streamingError.message}), and the classic fallback also failed: ${classicError.message}`,
							{ cause: classicError }
						);
					}
				}
			}
			return await self.install.classic(connection.socket, streamManager, localPath, installOptions);
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
 * same leaf.
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
		if (existing.isConnected()) {
			return existing;
		}
		// Stale entry from a prior connection that dropped without disconnect() -
		// detach it before mounting a fresh one at the same key.
		await self.slothlet.api.remove(`devices.${deviceKey}`).catch(() => {});
	}

	// Get or create RSA keys using self.auth
	const keys = await self.auth.getKeys(options.keyDir);

	// Create connection using self.connection
	const connection = await self.connection.create({
		host,
		port,
		publicKey: keys.publicKey,
		privateKey: keys.privateKey,
		adbPublicKey: keys.adbPublicKey
	});

	// Create stream manager using self.stream
	const streamManager = await self.stream.create(connection.socket);

	// Set up packet routing
	connection.onUnhandledPacket = (packet) => streamManager.handlePacket(packet);

	const leaf = buildDeviceLeaf(host, port, deviceId, deviceKey, connection, streamManager);

	await self.slothlet.api.add(`devices.${deviceKey}`, leaf, { moduleID: `device:${deviceId}` });

	// connection/streamManager are assigned onto the mounted leaf AFTER add()
	// rather than included in the object passed to it: add()'s flatten+wrap
	// pipeline hangs indefinitely when a real net.Socket (deeply nested,
	// self-referential internals) is present anywhere in its input - a plain
	// property write on the already-mounted wrapper doesn't have the same
	// problem and is how the framework's own "wrap-on-set" mechanism is
	// documented to work (CONTEXT-PROPAGATION.md). Confirmed these are still
	// externally readable (device.connection.socket, device.streamManager)
	// exactly as documented in docs/API.md.
	self.devices[deviceKey].connection = connection;
	self.devices[deviceKey].streamManager = streamManager;

	return self.devices[deviceKey];
}

/**
 * Disconnects from a specific device.
 * @param {string} host - Device host
 * @param {number} [port=5555] - Device port
 * @returns {Promise<boolean>} True if a device was found and disconnected
 */
export async function disconnect(host, port = 5555) {
	const deviceKey = sanitizeKey(`${host}:${port}`);
	const entry = self.devices && self.devices[deviceKey];
	if (!entry) {
		return false;
	}
	await entry.disconnect();
	return true;
}
