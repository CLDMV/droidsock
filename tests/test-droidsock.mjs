/**
 *	@Project: @cldmv/droidsock
 *	@Filename: /tests/test-droidsock.mjs
 *	@Date: 2025-11-21 12:35:15 -08:00 (1763757315)
 *	@Author: Nate Hyson <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Hyson <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2025-11-21 14:26:00 -08:00 (1763763960)
 *	-----
 *	@Copyright: Copyright (c) 2013-2025 Catalyzed Motivation Inc. All rights reserved.
 */

/**
 * Test script for DroidSock slothlet implementation
 */

import createDroidSock from "../index.mjs";
import fs from "node:fs";
import path from "node:path";

// Load device configurations
const devicesPath = path.join(process.cwd(), "references", "devices.json");
let devices = {};

try {
	const devicesData = fs.readFileSync(devicesPath, "utf8");
	devices = JSON.parse(devicesData);
} catch (error) {
	console.warn("⚠️  Could not load devices.json:", error.message);
}

async function testDroidSock() {
	console.log("🚀 Testing DroidSock slothlet implementation...\n");

	try {
		// Create DroidSock API instance with initial config
		console.log("📦 Creating DroidSock API instance...");
		const droidsock = await createDroidSock({
			mode: "eager",
			config: {
				debug: true,
				verbose: true,
				silent: false // Ensure output for testing
			},
			context: {
				testRun: true,
				timestamp: new Date().toISOString()
			}
		});

		console.log("✅ DroidSock API created and configured successfully!");
		console.log("📋 Available API modules:", Object.keys(droidsock));

		// Test auth module
		console.log("\n🔐 Testing auth module...");
		if (droidsock.auth) {
			console.log("  - auth.getKeys available:", typeof droidsock.auth.getKeys === "function");
			console.log("  - auth.generateKeys available:", typeof droidsock.auth.generateKeys === "function");
			console.log("  - auth.sign available:", typeof droidsock.auth.sign === "function");

			// Test key generation
			try {
				console.log("  - Testing key generation...");
				const keys = droidsock.auth.generateKeys(1024); // Smaller key for testing
				console.log("  ✅ Key generation successful");
				console.log("  - Private key length:", keys.privateKey.length);
				console.log("  - Public key length:", keys.publicKey.length);
				console.log("  - ADB public key length:", keys.adbPublicKey.length);
			} catch (error) {
				console.log("  ❌ Key generation failed:", error.message);
			}
		} else {
			console.log("  ❌ auth module not available");
		}

		// Test utils module
		console.log("\n🛠️ Testing utils module...");
		if (droidsock.utils) {
			console.log("  - utils.parseProperties available:", typeof droidsock.utils.parseProperties === "function");
			console.log("  - utils.formatBytes available:", typeof droidsock.utils.formatBytes === "function");
			console.log("  - utils.isValidIP available:", typeof droidsock.utils.isValidIP === "function");

			// Test utility functions
			try {
				console.log("  - Testing formatBytes...");
				const formatted = droidsock.utils.formatBytes(1024);
				console.log("  ✅ formatBytes(1024) =", formatted);

				console.log("  - Testing IP validation...");
				const validIP = droidsock.utils.isValidIP("192.168.1.1");
				const invalidIP = droidsock.utils.isValidIP("invalid");
				console.log('  ✅ isValidIP("192.168.1.1") =', validIP);
				console.log('  ✅ isValidIP("invalid") =', invalidIP);
			} catch (error) {
				console.log("  ❌ Utils test failed:", error.message);
			}
		} else {
			console.log("  ❌ utils module not available");
		}

		// Test device module structure
		console.log("\n📱 Testing device module...");
		if (droidsock.device) {
			console.log("  - device.connect available:", typeof droidsock.device.connect === "function");
			console.log("  - device.list available:", typeof droidsock.device.list === "function");
			console.log("  - device.disconnect available:", typeof droidsock.device.disconnect === "function");
		} else {
			console.log("  ❌ device module not available");
		}

		// Test shell module structure
		console.log("\n🐚 Testing shell module...");
		if (droidsock.shell) {
			console.log("  - shell.execute available:", typeof droidsock.shell.execute === "function");
			console.log("  - shell.startStreaming available:", typeof droidsock.shell.startStreaming === "function");
			console.log("  - shell.startInteractive available:", typeof droidsock.shell.startInteractive === "function");
			console.log("  - shell.commands available:", typeof droidsock.shell.commands === "object");
		} else {
			console.log("  ❌ shell module not available");
		}

		console.log("\n✨ Basic API structure test completed!");

		// Check for device connection test
		const deviceName = process.argv[2];
		if (deviceName && devices[deviceName]) {
			try {
				await testDeviceConnection(droidsock, deviceName, devices[deviceName]);
			} catch (connectionError) {
				console.error("\n❌ Device connection test failed:", connectionError.message);
				console.error("📍 This is expected if the device is not available or ADB is not enabled");

				// Shutdown slothlet and exit cleanly
				if (droidsock.shutdown) {
					await droidsock.shutdown();
				}
				process.exit(1);
			}
		} else if (deviceName && !devices[deviceName]) {
			console.log(`\n❌ Device "${deviceName}" not found in devices.json`);
			console.log(
				"📋 Available devices:",
				Object.keys(devices).filter((key) => key !== "default")
			);
			// Exit cleanly for invalid device name
			if (droidsock.shutdown) {
				await droidsock.shutdown();
			}
			process.exit(1);
		} else if (devices.default) {
			console.log(`\n💡 To test with a device, use: node test-droidsock.mjs ${devices.default}`);
			console.log(
				"📋 Available devices:",
				Object.keys(devices).filter((key) => key !== "default")
			);
		} else {
			console.log("\n⚠️  Note: Connection tests would require an actual ADB device");
			console.log("     To test with a real device, use:");
			console.log('     const device = await droidsock.device.connect("192.168.1.100", 5555);');
		}

		// Always shutdown cleanly on success
		if (droidsock.shutdown) {
			await droidsock.shutdown();
		}
		console.log("\n✨ Test completed successfully!");
	} catch (error) {
		console.error("❌ Test failed:", error);
		console.error("Stack:", error.stack);

		// Shutdown slothlet and exit
		try {
			if (droidsock && droidsock.shutdown) {
				await droidsock.shutdown();
			}
		} catch (shutdownError) {
			console.error("Failed to shutdown cleanly:", shutdownError.message);
		}
		process.exit(1);
	}
}

/**
 * Tests actual device connection using device info from devices.json
 * @param {Object} droidsock - DroidSock API instance
 * @param {string} deviceName - Device name
 * @param {Object} deviceInfo - Device configuration
 */
async function testDeviceConnection(droidsock, deviceName, deviceInfo) {
	console.log(`\n📱 Testing connection to ${deviceName} (${deviceInfo.name})...`);
	console.log(`   Host: ${deviceInfo.host}:${deviceInfo.port}`);
	console.log(`   Location: ${deviceInfo.location}`);

	// Create timeout promise for connection
	const connectionTimeout = new Promise((_, reject) => {
		setTimeout(() => reject(new Error("Connection timeout after 15 seconds")), 15000);
	});

	try {
		console.log("\n🔌 Attempting to connect...");
		const device = await Promise.race([
			droidsock.device.connect(deviceInfo.host, deviceInfo.port, {
				timeout: 10000 // 10 second timeout
			}),
			connectionTimeout
		]);

		if (device.isConnected()) {
			console.log("✅ Device connected successfully!");

			// Test shell commands
			try {
				// Test basic shell command
				console.log("\n🐚 Testing basic shell command (echo hello)...");
				const echoResult = await device.shell("echo hello");
				console.log("✅ Echo result:", echoResult.trim());

				console.log("\n🐚 Testing shell command (id)...");
				const idResult = await device.shell("id");
				console.log("✅ ID result:", idResult.trim());

				console.log("\n🐚 Testing shell command (getprop ro.product.model)...");
				const model = await device.shell("getprop ro.product.model");
				console.log("✅ Device model:", model.trim() || "(empty)");
				console.log("   Raw output length:", model.length);
				if (model.length > 0) {
					console.log(
						"   Raw output bytes:",
						model
							.split("")
							.map((c) => c.charCodeAt(0))
							.slice(0, 10)
					);
				}

				// Test battery info
				console.log("\n🔋 Testing battery info...");
				const batteryRaw = await device.shell("dumpsys battery | head -20");
				console.log("✅ Battery info (first 20 lines):");
				console.log(
					batteryRaw
						.split("\n")
						.slice(0, 5)
						.map((line) => `     ${line}`)
						.join("\n")
				);

				// Test ls command
				console.log("\n📁 Testing directory listing (/system)...");
				const lsResult = await device.shell("ls -la /system | head -10");
				console.log("✅ Directory listing (first 10 entries):");
				console.log(
					lsResult
						.split("\n")
						.slice(0, 5)
						.map((line) => `     ${line}`)
						.join("\n")
				);
			} catch (shellError) {
				console.log("❌ Shell command failed:", shellError.message);
			}

			// Clean disconnect
			console.log("\n🔌 Disconnecting...");
			device.disconnect();
			console.log("✅ Device disconnected successfully!");
		} else {
			console.log("❌ Device connection failed - not connected");
		}
	} catch (connectionError) {
		console.log("❌ Connection failed:", connectionError.message);
		console.log("💡 Make sure the device has ADB enabled and is reachable");
		console.log("💡 You may need to accept the authorization dialog on the device");

		// Re-throw to be handled by the calling function
		throw connectionError;
	}
}

// Run the test
testDroidSock().catch(console.error);
