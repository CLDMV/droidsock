/**
 *	@Project: @cldmv/droidsock
 *	@Filename: /src/api/devices.mjs
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
 * Device connection and management API module for DroidSock.
 *
 * Connected devices live directly on this module's own slothlet namespace
 * (self.devices / api.devices) as real, individually-addressable leaves -
 * not in a local variable private to this file. connect() mounts each new
 * connection with api.slothlet.api.add() (docs/RELOAD.md) at
 * `devices.<sanitized host_port>`, alongside this module's own
 * connect/list/disconnect/disconnectAll exports, and disconnect() unmounts
 * it the same way. self access inside a device's methods works correctly on
 * every call because they're genuine tree leaves invoked through the normal
 * apply-trap path - unlike a plain object returned from an async function
 * (which depends on slothlet's class-instance context-preservation
 * mechanism, and that mechanism never actually fires for an async function's
 * return value - see the linked issue below), and unlike a plain
 * `self.devices[key] = <object>` assignment (slothlet's documented
 * "wrap-on-set" behavior, CONTEXT-PROPAGATION.md - empirically this does NOT
 * give the assigned object's methods working self access the way add() does,
 * despite the doc describing it as using "the same wrapper construction").
 */

import { self } from "@cldmv/slothlet/runtime";

/**
 * Sanitizes a `host:port` device id into a slothlet-safe api-path segment.
 * `.` and `:` are ordinary characters in an IP:port string but are the
 * tree's own path-separator-adjacent punctuation, so they're replaced.
 * @param {string} deviceId - `${host}:${port}`
 * @returns {string} A path-safe key, e.g. "10_6_0_108_5555"
 */
function sanitizeKey(deviceId) {
	return deviceId.replace(/[.:]/g, "_");
}

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
			await self.slothlet.api.remove(`devices.${deviceKey}`);
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
				} catch {
					// Fall through to the classic push-then-install flow.
				}
			}
			return await self.install.classic(connection.socket, streamManager, localPath, installOptions);
		},

		// Convenience shell shortcuts
		ls: (path = ".") => leaf.shell(`ls -la "${path}"`),
		pwd: () => leaf.shell("pwd"),
		getprop: (prop = null) => leaf.shell(prop ? `getprop "${prop}"` : "getprop"),
		getModel: () => leaf.shell("getprop ro.product.model"),
		getAndroidVersion: () => leaf.shell("getprop ro.build.version.release"),
		getBattery: () => leaf.shell("dumpsys battery"),
		screenshot: (filename = "/sdcard/screenshot.png") => leaf.shell(`screencap -p "${filename}"`),
		logcat: (logOptions = {}) => leaf.startStreamingShell("logcat", logOptions),
		top: (topOptions = {}) => leaf.startStreamingShell("top -m 10", topOptions),
		keypress: (key) => leaf.shell(`input keyevent ${key}`),
		launchApp: (packageName, activity = "") => {
			const activityArg = activity ? `/${activity}` : "";
			return leaf.shell(`am start -n ${packageName}${activityArg}`);
		},
		rebootBootloader: () => leaf.reboot("bootloader"),
		rebootRecovery: () => leaf.reboot("recovery"),
		rebootSideload: () => leaf.reboot("sideload")
	};

	return leaf;
}

/**
 * Returns the live device-leaf entries under self.devices, excluding this
 * module's own connect/list/disconnect/disconnectAll siblings (identified by
 * having a callable isConnected() - the module's own exports are functions,
 * not objects, so this needs no hardcoded name list).
 * @returns {Array<Object>} Device leaf entries (regardless of connected state)
 */
function deviceEntries() {
	const registry = self.devices || {};
	return Object.keys(registry)
		.map((key) => registry[key])
		.filter((entry) => entry && typeof entry === "object" && typeof entry.isConnected === "function");
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
 * Lists all currently-connected devices.
 * @returns {Array<Object>} Connected device leaves
 */
export function list() {
	return deviceEntries().filter((entry) => entry.isConnected());
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

/**
 * Disconnects from all devices.
 * @returns {Promise<number>} Number of devices disconnected
 */
export async function disconnectAll() {
	const entries = deviceEntries();
	let count = 0;
	for (const entry of entries) {
		await entry.disconnect();
		count++;
	}
	return count;
}
