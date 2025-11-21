/**
 * Test script for the refactored DroidSock API with config and logging
 */

import createDroidSock from "../index.mjs";

async function testConfigAndLogging() {
	try {
		console.log("Creating DroidSock API...");
		const api = await createDroidSock();

		console.log("Testing config access...");
		// Test config access
		console.log("Default host:", api.config.get("host"));
		console.log("Default port:", api.config.get("port"));
		console.log("Debug enabled:", api.config.get("debug"));

		// Set some config values
		api.config.set("debug", true);
		api.config.set("verbose", true);
		console.log("After setting debug=true:", api.config.get("debug"));

		console.log("Testing logging...");
		// Test logging
		api.log.debug("This is a debug message");
		api.log.verbose("This is a verbose message");
		api.log.info("This is an info message");
		api.log.warn("This is a warning message");
		api.log.error("This is an error message");

		console.log("Testing silent mode...");
		// Test silent mode
		api.config.set("silent", true);
		api.log.debug("This debug message should be silent");
		api.log.info("This info message should be silent");
		api.log.warn("This warning should be silent");
		api.log.error("This error should be silent");

		console.log("Test completed successfully!");
		console.log("Config all:", JSON.stringify(api.config.all(), null, 2));
	} catch (error) {
		console.error("Test failed:", error);
	}
}

testConfigAndLogging();
