/**
 *	@Project: @cldmv/droidsock
 *	@Filename: /index.mjs
 *	@Date: 2025-11-21 14:04:10 -08:00
 *	@Author: Nate Hyson <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Hyson <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2025-11-21 14:47:33 -08:00 (1763765253)
 *	-----
 *	@Copyright: Copyright (c) 2013-2025 Catalyzed Motivation Inc. All rights reserved.
 */

// Development environment check (must happen before droidsock imports)
(async () => {
	try {
		await import("./devcheck.mjs");
	} catch {
		// ignore
	}
})();

/**
 * Creates a DroidSock instance for ADB communication
 * @param {object} [options={}] - Configuration options
 * @returns {Promise<object>} DroidSock instance
 */
export default async function createDroidSock(options = {}) {
	// Dynamic import after environment check
	const mod = await import("@cldmv/droidsock/main");
	const createDroidSockImpl = mod.default;
	return await createDroidSockImpl(options);
}

/**
 * Connect to a device
 * @param {string} deviceId - Device ID to connect to
 * @returns {Promise<object>} Connected device instance
 */
export async function connect(deviceId) {
	const mod = await import("@cldmv/droidsock/main");
	return mod.connect(deviceId);
}

/**
 * List available devices
 * @returns {Promise<Array>} List of available devices
 */
export async function listDevices() {
	const mod = await import("@cldmv/droidsock/main");
	return mod.listDevices();
}

// Named export aliases
export { createDroidSock as DroidSock };
export { createDroidSock as ADB };
export { createDroidSock as AndroidDebugBridge };
