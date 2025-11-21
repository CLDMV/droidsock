/**
 *	@Project: @cldmv/droidsock
 *	@Filename: /src/api/device.mjs
 *	@Date: 2025-11-21 12:18:12 -08:00 (1763756292)
 *	@Author: Nate Hyson <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Hyson <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2025-11-21 14:05:45 -08:00 (1763762745)
 *	-----
 *	@Copyright: Copyright (c) 2013-2025 Catalyzed Motivation Inc. All rights reserved.
 */

/**
 * Device connection and management API module for DroidSock
 */

import { self, context } from "@cldmv/slothlet/runtime";

// Track active connections
const connections = new Map();

/**
 * Connects to an ADB device
 * @param {string} host - Device host/IP address
 * @param {number} [port=5555] - Device port
 * @param {Object} [options={}] - Connection options
 * @param {string} [options.keyDir] - Directory for RSA keys (default: ~/.adb)
 * @returns {Promise<Object>} Device instance with methods
 */
export async function connect(host, port = 5555, options = {}) {
	const deviceId = `${host}:${port}`;

	// Check if already connected
	if (connections.has(deviceId)) {
		const existing = connections.get(deviceId);
		if (existing.isConnected()) {
			return existing;
		} else {
			// Clean up stale connection
			connections.delete(deviceId);
		}
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

	// Create device instance
	const device = {
		host,
		port,
		deviceId,
		connection,
		streamManager,

		// Core methods
		isConnected: () => connection && connection.connected,
		disconnect: () => {
			if (connection) {
				connection.disconnect();
				connections.delete(deviceId);
			}
		},

		// Shell operations - use self to access other modules
		shell: async (command, shellOptions = {}) => {
			if (!device.isConnected()) {
				throw new Error("Device not connected");
			}
			if (!connection.authorized) {
				throw new Error("Device not authorized. Please accept authorization dialog.");
			}
			return await self.shell.execute(connection.socket, streamManager, command, {
				...shellOptions,
				deviceFeatures: connection.deviceFeatures || []
			});
		},

		startStreamingShell: (command, shellOptions = {}) => {
			if (!device.isConnected()) {
				throw new Error("Device not connected");
			}
			if (!connection.authorized) {
				throw new Error("Device not authorized. Please accept authorization dialog.");
			}
			return self.shell.startStreaming(connection.socket, streamManager, command, shellOptions);
		},

		startInteractiveShell: (command, shellOptions = {}) => {
			if (!device.isConnected()) {
				throw new Error("Device not connected");
			}
			if (!connection.authorized) {
				throw new Error("Device not authorized. Please accept authorization dialog.");
			}
			return self.shell.startInteractive(connection.socket, streamManager, command, shellOptions);
		},

		// File operations (using self.files)
		push: async (localPath, remotePath, transferOptions = {}) => {
			if (!device.isConnected()) {
				throw new Error("Device not connected");
			}
			if (!connection.authorized) {
				throw new Error("Device not authorized. Please accept authorization dialog.");
			}
			return await self.files.push(connection.socket, streamManager, localPath, remotePath, transferOptions);
		},

		pull: async (remotePath, localPath, transferOptions = {}) => {
			if (!device.isConnected()) {
				throw new Error("Device not connected");
			}
			if (!connection.authorized) {
				throw new Error("Device not authorized. Please accept authorization dialog.");
			}
			return await self.files.pull(connection.socket, streamManager, remotePath, localPath, transferOptions);
		},

		list: async (remotePath) => {
			if (!device.isConnected()) {
				throw new Error("Device not connected");
			}
			if (!connection.authorized) {
				throw new Error("Device not authorized. Please accept authorization dialog.");
			}
			return await self.files.list(connection.socket, streamManager, remotePath);
		},

		stat: async (remotePath) => {
			if (!device.isConnected()) {
				throw new Error("Device not connected");
			}
			if (!connection.authorized) {
				throw new Error("Device not authorized. Please accept authorization dialog.");
			}
			return await self.files.stat(connection.socket, streamManager, remotePath);
		},

		// Convenience properties using self to access commands module
		get ls() {
			return (path = ".") => device.shell(`ls -la "${path}"`);
		},
		get pwd() {
			return () => device.shell("pwd");
		},
		get getprop() {
			return (prop = null) => device.shell(prop ? `getprop "${prop}"` : "getprop");
		},
		get getModel() {
			return () => device.shell("getprop ro.product.model");
		},
		get getAndroidVersion() {
			return () => device.shell("getprop ro.build.version.release");
		},
		get getBattery() {
			return () => device.shell("dumpsys battery");
		},
		get screenshot() {
			return (filename = "/sdcard/screenshot.png") => device.shell(`screencap -p "${filename}"`);
		},
		get logcat() {
			return (logOptions = {}) => device.startStreamingShell("logcat", logOptions);
		},
		get top() {
			return (topOptions = {}) => device.startStreamingShell("top -m 10", topOptions);
		},
		get keypress() {
			return (key) => device.shell(`input keyevent ${key}`);
		},
		get launchApp() {
			return (packageName, activity = "") => {
				const activityArg = activity ? `/${activity}` : "";
				return device.shell(`am start -n ${packageName}${activityArg}`);
			};
		}
	};

	// Store connection
	connections.set(deviceId, device);

	return device;
}

/**
 * Lists all active connections
 * @returns {Array} List of connected devices
 */
export function list() {
	return Array.from(connections.values()).filter((device) => device.isConnected());
}

/**
 * Disconnects from a specific device
 * @param {string} host - Device host
 * @param {number} [port=5555] - Device port
 * @returns {boolean} True if device was found and disconnected
 */
export function disconnect(host, port = 5555) {
	const deviceId = `${host}:${port}`;
	const device = connections.get(deviceId);
	if (device) {
		device.disconnect();
		return true;
	}
	return false;
}

/**
 * Disconnects from all devices
 * @returns {number} Number of devices disconnected
 */
export function disconnectAll() {
	let count = 0;
	for (const device of connections.values()) {
		device.disconnect();
		count++;
	}
	connections.clear();
	return count;
}
