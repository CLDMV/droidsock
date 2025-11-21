/**
 * Basic ADB usage example
 *
 * Demonstrates connecting to a device and executing basic commands.
 */

import createDroidSock from "../index.mjs";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Helper function for delays
function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
	try {
		// Load device configuration
		const devicesPath = path.join(__dirname, "..", "references", "devices.json");
		const devices = JSON.parse(fs.readFileSync(devicesPath, "utf8"));

		// Use default device or specify one
		const deviceName = process.argv[2] || devices.default;
		const device = devices[deviceName];

		if (!device) {
			console.error(`Device '${deviceName}' not found in devices.json`);
			console.log(
				"Available devices:",
				Object.keys(devices).filter((k) => k !== "default")
			);
			process.exit(1);
		}

		console.log(`Connecting to ${device.name} (${device.host}:${device.port})...`);

		// Create DroidSock API instance
		const droidsock = await createDroidSock({
			config: {
				debug: true,
				verbose: true
			}
		});

		// Connect to device
		const deviceConnection = await droidsock.device.connect(device.host, device.port);

		if (!deviceConnection.isConnected()) {
			throw new Error("Failed to connect to device");
		}

		console.log("✅ Connected successfully!");

		// Execute some basic commands
		console.log("\n=== Device Information ===");

		const model = await deviceConnection.shell("getprop ro.product.model");
		console.log("Model:", model.trim());

		await delay(500); // Small delay between commands

		const androidVersion = await deviceConnection.shell("getprop ro.build.version.release");
		console.log("Android Version:", androidVersion.trim());

		await delay(500);

		const pwd = await deviceConnection.shell("pwd");
		console.log("Current Directory:", pwd.trim());

		await delay(500);

		console.log("\n=== Directory Listing ===");
		const ls = await deviceConnection.shell("ls -la /sdcard | head -10");
		console.log(ls);

		await delay(500);

		console.log("\n=== Battery Status ===");
		const battery = await deviceConnection.shell("dumpsys battery | head -20");
		console.log(battery);

		await delay(500);

		// Take a screenshot
		console.log("\n=== Taking Screenshot ===");
		const screencapResult = await deviceConnection.shell(`screencap -p "/sdcard/screenshot.png" && echo "SUCCESS" || echo "FAILED"`);
		console.log("Screencap result:", screencapResult.trim());

		// Check file size before pulling
		console.log("\n=== Checking Screenshot Size ===");
		const fileSize = await deviceConnection.shell("ls -la /sdcard/screenshot.png");
		console.log("File info:", fileSize.trim());

		// Try creating a small test file
		console.log("\n=== Testing File Creation ===");
		try {
			await deviceConnection.shell("echo 'test content from DroidSock' > /sdcard/test.txt");
			const testFile = await deviceConnection.shell("ls -la /sdcard/test.txt");
			console.log("Test file info:", testFile.trim());
			console.log("✅ File operations working");
		} catch (error) {
			console.log("❌ File operation failed:", error.message);
		}

		await delay(500);

		// Note: File pulling requires additional implementation in the files API
		console.log("\n=== File Operations ===");
		console.log("Note: File pull/push operations require files API implementation");

		await delay(500);

		// Test input event (volume up)
		console.log("\n=== Testing Input Event ===");
		try {
			await deviceConnection.shell("input keyevent 24"); // KEYCODE_VOLUME_UP
			console.log("✅ Volume up key sent");
		} catch (error) {
			console.log("❌ Input event failed:", error.message);
		}

		await delay(500);

		// Test app launch (try to launch settings)
		console.log("\n=== Testing App Launch ===");
		try {
			await deviceConnection.shell("am start -n com.android.settings/.Settings");
			console.log("✅ Settings app launch command sent");
		} catch (error) {
			console.log("❌ Could not launch settings app:", error.message);
		}

		await delay(1000);

		// Clean up
		deviceConnection.disconnect();
		console.log("\n✅ Disconnected from device");

		// Shutdown slothlet
		if (droidsock.shutdown) {
			await droidsock.shutdown();
		}
	} catch (error) {
		console.error("Error:", error.message);
		process.exit(1);
	}
}

// Run if called directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main();
}

export default main;
