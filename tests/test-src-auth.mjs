/**
 *	@Project: droidsock
 *	@Filename: /tests/test-src-auth.mjs
 *	@Date: 2025-11-21 09:43:03 -08:00 (1763746983)
 *	@Author: Nate Hyson <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Hyson <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2025-11-21 09:44:04 -08:00 (1763747044)
 *	-----
 *	@Copyright: Copyright (c) 2013-2025 Catalyzed Motivation Inc. All rights reserved.
 */

/**
 * Test the DroidSock authentication implementation
 */

import createDroidSock from "../index.mjs";

const deviceIp = process.argv[2] || "10.6.0.108";
const devicePort = 5555;

async function testConnection() {
	console.log(`Testing connection to ${deviceIp}:${devicePort}`);

	try {
		// Create DroidSock API instance
		const droidsock = await createDroidSock({
			config: {
				debug: true,
				verbose: true
			}
		});

		console.log("✅ DroidSock API created successfully");

		// Test connection using device API
		const device = await droidsock.device.connect(deviceIp, devicePort);

		if (device.isConnected()) {
			console.log("✅ Connection successful!");
			console.log("✅ Authentication working correctly!");

			// Test a simple shell command to verify everything works
			const result = await device.shell("echo 'Authentication test successful'");
			console.log("Shell test result:", result.trim());

			device.disconnect();
			console.log("✅ Connection closed cleanly");
		} else {
			throw new Error("Device not connected");
		}

		// Shutdown slothlet
		if (droidsock.shutdown) {
			await droidsock.shutdown();
		}
	} catch (error) {
		console.error("❌ Connection failed:", error.message);
		process.exit(1);
	}
}

testConnection().catch(console.error);
