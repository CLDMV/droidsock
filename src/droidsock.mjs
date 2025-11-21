/**
 * DroidSock - Android Debug Bridge Client
 * Entry point for slothlet-based modular API
 */

import slothlet from "@cldmv/slothlet";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Creates a new DroidSock API instance with slothlet modular loading
 * @param {Object} options - Configuration options
 * @param {string} [options.mode='eager'] - Loading mode: 'lazy' or 'eager'
 * @param {Object} [options.context={}] - Context object for API modules
 * @param {Object} [options.config={}] - Initial configuration options
 * @returns {Promise<Object>} The DroidSock API instance
 */
export default async function createDroidSock(options = {}) {
	const { mode = "eager", context = {}, config = {}, ...slothletOptions } = options;

	// Create slothlet API with our api folder
	const api = await slothlet({
		dir: path.join(__dirname, "api"),
		mode,
		runtime: "live", // Enable live bindings for self-references
		context: {
			...context
			// Add any default context here
		},
		debug: false, // Will be controlled by config module
		// Sanitize options for clean API naming
		sanitize: {
			lowerFirst: false,
			rules: {
				leave: ["ADB", "TCP", "USB", "Auth", "Sync"],
				upper: ["adb*", "tcp*", "usb*"]
			}
		},
		...slothletOptions
	});

	// Initialize config with provided options
	if (Object.keys(config).length > 0) {
		api.config.init(config);
	}

	return api;
}

/**
 * Quick connection helper for common use cases
 * @param {string} host - Device host/IP
 * @param {number} [port=5555] - Device port
 * @param {Object} [options={}] - Additional options
 * @returns {Promise<Object>} Connected device instance
 */
export async function connect(host, port = 5555, options = {}) {
	const droidsock = await createDroidSock(options);
	return await droidsock.device.connect(host, port);
}

/**
 * List connected devices
 * @param {Object} [options={}] - Additional options
 * @returns {Promise<Array>} List of connected devices
 */
export async function listDevices(options = {}) {
	const droidsock = await createDroidSock(options);
	return await droidsock.device.list();
}
