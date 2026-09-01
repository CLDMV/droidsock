/**
 *	@Project: @cldmv/droidsock
 *	@Filename: /examples/streaming-example.mjs
 *	@Date: 2025-11-21T15:41:06-08:00 (1763768466)
 *	@Author: Shinrai <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Shinrai <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-08-30 16:02:20 -07:00 (1788130940)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 */

/**
 * Streaming commands example
 *
 * Demonstrates streaming commands like logcat and top.
 */

import droidsock from "../index.mjs";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function logcatExample() {
	const devices = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "references", "devices.json"), "utf8"));
	const device = devices[devices.default];

	// Create DroidSock API instance
	const api = await droidsock({
		config: {
			debug: false, // Less noise for streaming
			verbose: false
		}
	});

	const deviceConnection = await api.device.connect(device.host, device.port);
	console.log("✅ Connected for logcat streaming...");

	// Note: Streaming functionality needs to be implemented in the shell API
	// For now, demonstrate with shell command that shows logcat output
	console.log("📋 Starting logcat (showing last 20 lines, then real-time)...");

	try {
		// Show recent logcat entries
		const recentLogcat = await deviceConnection.shell("logcat -d -t 20");
		console.log("Recent logcat entries:");
		console.log(recentLogcat);

		console.log("\n🔄 For continuous logcat streaming, use shell.startStreaming() method");
		console.log("Note: Full streaming implementation requires additional shell API methods");
	} catch (error) {
		console.error("❌ Logcat error:", error.message);
	}

	// Clean up
	setTimeout(() => {
		console.log("\n✅ Disconnecting...");
		deviceConnection.disconnect();
		if (api.shutdown) {
			api.shutdown();
		}
	}, 2000);
}

async function topExample() {
	const devices = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "references", "devices.json"), "utf8"));
	const device = devices[devices.default];

	// Create DroidSock API instance
	const api = await droidsock({
		config: {
			debug: false,
			verbose: false
		}
	});

	const deviceConnection = await api.device.connect(device.host, device.port);
	console.log("✅ Connected for system info...");

	try {
		// Show system processes (similar to top)
		console.log("📊 System process information:");
		const topOutput = await deviceConnection.shell("top -n 1 | head -20");
		console.log(topOutput);

		console.log("\n💾 Memory information:");
		const memInfo = await deviceConnection.shell("cat /proc/meminfo | head -10");
		console.log(memInfo);

		console.log("\n⚡ CPU information:");
		const cpuInfo = await deviceConnection.shell("cat /proc/cpuinfo | head -20");
		console.log(cpuInfo);
	} catch (error) {
		console.error("❌ System info error:", error.message);
	}

	// Clean up
	setTimeout(() => {
		console.log("\n✅ Disconnecting...");
		deviceConnection.disconnect();
		if (api.shutdown) {
			api.shutdown();
		}
	}, 1000);
}

async function fileTransferExample() {
	const devices = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "references", "devices.json"), "utf8"));
	const device = devices[devices.default];

	// Create DroidSock API instance
	const api = await droidsock({
		config: {
			debug: true,
			verbose: false
		}
	});

	const deviceConnection = await api.device.connect(device.host, device.port);
	console.log("✅ Connected for file operations...");

	try {
		// List a directory using shell commands
		console.log("📁 Listing /sdcard:");
		const listing = await deviceConnection.shell("ls -la /sdcard | head -15");
		console.log(listing);

		// Create a test file on device
		console.log("\n📝 Creating test file on device...");
		const testContent = "Hello from DroidSock implementation!\nTimestamp: " + new Date().toISOString();
		await deviceConnection.shell(`echo '${testContent}' > /sdcard/droidsock-test.txt`);

		// Verify file was created
		const fileInfo = await deviceConnection.shell("ls -la /sdcard/droidsock-test.txt");
		console.log("File created:", fileInfo.trim());

		// Read file content back
		const readContent = await deviceConnection.shell("cat /sdcard/droidsock-test.txt");
		console.log("File content:", readContent.trim());

		// Note about file transfer
		console.log("\n📋 Note: Full file push/pull operations require files API implementation");
		console.log("Current implementation supports shell-based file operations");

		// Clean up test file
		await deviceConnection.shell("rm /sdcard/droidsock-test.txt");
		console.log("✅ Test file cleaned up");
	} catch (error) {
		console.error("❌ File operation error:", error.message);
	}

	// Clean up
	deviceConnection.disconnect();
	if (api.shutdown) {
		await api.shutdown();
	}
}

function main() {
	const command = process.argv[2] || "logcat";

	switch (command) {
		case "logcat":
			logcatExample();
			break;
		case "top":
			topExample();
			break;
		case "files":
			fileTransferExample();
			break;
		default:
			console.log("Usage: node streaming-example.mjs [logcat|top|files]");
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main();
}

export default main;
