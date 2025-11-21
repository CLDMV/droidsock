#!/usr/bin/env node

/**
 * Test connection without any authentication to see if that eliminates clicks
 */

import net from "net";
import createDroidSock from "../index.mjs";

async function testNoAuthConnect() {
	console.log("Testing connection to see if authentication is required...");

	try {
		// Create DroidSock API instance with minimal config
		const droidsock = await createDroidSock({
			config: {
				debug: true,
				verbose: false
			}
		});

		console.log("✅ DroidSock API created successfully");

		// Try to connect - this will show us the authentication flow
		console.log("Attempting connection to 10.6.0.108:5555...");

		try {
			const device = await droidsock.device.connect("10.6.0.108", 5555, {
				timeout: 5000
			});

			if (device.isConnected()) {
				console.log("✅ Device connected successfully!");
				console.log("Device appears to be already authorized or doesn't require authentication");

				// Test basic functionality
				const result = await device.shell("echo 'Connection test'");
				console.log("Shell test result:", result.trim());

				device.disconnect();
				console.log("✅ Connection closed cleanly");
				return "no_auth_needed";
			} else {
				console.log("❌ Device connection failed");
				return "connection_failed";
			}
		} catch (error) {
			if (error.message.includes("authorization") || error.message.includes("accept")) {
				console.log("🔐 Device requires authentication - this may cause audio clicks");
				console.log("Error:", error.message);
				return "auth_required";
			} else {
				console.error("❌ Connection error:", error.message);
				return "connection_error";
			}
		} finally {
			// Shutdown slothlet
			if (droidsock.shutdown) {
				await droidsock.shutdown();
			}
		}
	} catch (error) {
		console.error("❌ API creation failed:", error.message);
		return "api_error";
	}
}

testNoAuthConnect()
	.then((result) => {
		console.log("Result:", result);
		process.exit(0);
	})
	.catch((error) => {
		console.error("Test failed:", error.message);
		process.exit(1);
	});
