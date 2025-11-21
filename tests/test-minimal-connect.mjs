#!/usr/bin/env node

/**
 * Minimal ADB connection test to isolate clicking sounds during handshake
 */

import createDroidSock from "../index.mjs";

async function testMinimalConnect() {
	try {
		console.log("Testing minimal connection to isolate clicking sounds...");

		// Create DroidSock API instance
		const droidsock = await createDroidSock({
			config: {
				debug: false, // Minimal logging to reduce noise
				verbose: false
			}
		});

		console.log("✅ DroidSock API created");

		// Just connect and immediately disconnect
		const device = await droidsock.device.connect("10.6.0.108", 5555);
		console.log("✅ Connected successfully");

		// Wait a moment then disconnect
		setTimeout(async () => {
			device.disconnect();
			console.log("✅ Disconnected - did you hear clicks during the handshake?");

			// Shutdown slothlet
			if (droidsock.shutdown) {
				await droidsock.shutdown();
			}

			process.exit(0);
		}, 1000);
	} catch (error) {
		console.error("❌ Connection failed:", error.message);
		process.exit(1);
	}
}

testMinimalConnect();
