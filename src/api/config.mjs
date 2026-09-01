/**
 *	@Project: @cldmv/droidsock
 *	@Filename: /src/api/config.mjs
 *	@Date: 2025-11-21 13:33:13 -08:00 (1763760793)
 *	@Author: Nate Hyson <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Hyson <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-08-30 16:02:20 -07:00 (1788130940)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 */

/**
 * Configuration module for DroidSock ADB client
 * Provides centralized configuration management throughout the API
 */

/**
 * Default configuration values
 */
const DEFAULT_CONFIG = {
	// Connection settings
	host: "127.0.0.1",
	port: 5555,
	timeout: 10000, // 10 seconds
	retryAttempts: 3,
	retryDelay: 1000,

	// Authentication settings
	keyDir: null, // Will default to ~/.adb or similar
	autoGenerateKeys: true,
	keySize: 2048,

	// Debug and logging
	debug: false,
	verbose: false,
	silent: false, // If true, suppresses all output
	debugArrowSent: ">>>>",
	debugArrowReceived: "<<<<",

	// Stream settings
	streamTimeout: 30000,
	maxStreams: 10,

	// Shell settings
	shellTimeout: 30000,
	shellEncoding: "utf8",

	// File transfer settings
	fileTimeout: 60000,
	chunkSize: 65536, // 64KB

	// Event settings
	emitEvents: true,
	eventPrefix: "adb",

	// Advanced settings
	bufferSize: 1024 * 1024, // 1MB
	keepAlive: true,
	keepAliveInterval: 30000
};

// Global config instance
let configInstance = null;

/**
 * Initialize or get the configuration instance
 * @param {Object} options - Initial configuration options
 * @returns {Object} Configuration API
 */
export function init(options = {}) {
	if (!configInstance) {
		configInstance = { ...DEFAULT_CONFIG, ...options };
	}
	return getApi();
}

/**
 * Get configuration value
 * @param {string} key - Configuration key (dot notation supported)
 * @param {*} defaultValue - Default value if key not found
 * @returns {*} Configuration value
 */
export function get(key, defaultValue = undefined) {
	if (!configInstance) {
		init();
	}

	const keys = key.split(".");
	let value = configInstance;

	for (const k of keys) {
		if (value && typeof value === "object" && k in value) {
			value = value[k];
		} else {
			return defaultValue;
		}
	}

	return value;
}

/**
 * Set a configuration value
 * @param {string} key - Configuration key (dot notation supported)
 * @param {*} value - Value to set
 */
export function set(key, value) {
	if (!configInstance) {
		init();
	}

	const keys = key.split(".");
	let obj = configInstance;

	for (let i = 0; i < keys.length - 1; i++) {
		const k = keys[i];
		if (!(k in obj) || typeof obj[k] !== "object") {
			obj[k] = {};
		}
		obj = obj[k];
	}

	obj[keys[keys.length - 1]] = value;
}

/**
 * Merge configuration options
 * @param {Object} options - Options to merge
 */
export function merge(options) {
	if (!configInstance) {
		init();
	}

	const mergeRecursive = (target, source, path = "") => {
		for (const [key, value] of Object.entries(source)) {
			const fullPath = path ? `${path}.${key}` : key;

			if (typeof value === "object" && value !== null && !Array.isArray(value)) {
				if (!(key in target) || typeof target[key] !== "object") {
					target[key] = {};
				}
				mergeRecursive(target[key], value, fullPath);
			} else {
				target[key] = value;
			}
		}
	};

	mergeRecursive(configInstance, options);
}

/**
 * Reset configuration to defaults
 */
export function reset() {
	configInstance = { ...DEFAULT_CONFIG };
}

/**
 * Get all configuration as plain object
 * @returns {Object} Configuration object
 */
export function all() {
	return configInstance ? { ...configInstance } : { ...DEFAULT_CONFIG };
}

/**
 * Get the configuration API
 * @returns {Object} Configuration API
 */
export function getApi() {
	return {
		init,
		get,
		set,
		merge,
		reset,
		all
	};
}

/**
 * Get default configuration
 * @returns {Object} Default configuration object
 */
export function getDefaults() {
	return { ...DEFAULT_CONFIG };
}

/**
 * Validate configuration object
 * @param {Object} config - Configuration to validate
 * @returns {Object} Validation result with errors array
 */
export function validateConfig(config) {
	const errors = [];

	// Validate connection settings
	if (config.port && (typeof config.port !== "number" || config.port < 1 || config.port > 65535)) {
		errors.push("port must be a number between 1 and 65535");
	}

	if (config.timeout && (typeof config.timeout !== "number" || config.timeout < 0)) {
		errors.push("timeout must be a non-negative number");
	}

	// Validate timeouts
	const timeouts = ["streamTimeout", "shellTimeout", "fileTimeout"];
	for (const timeout of timeouts) {
		if (config[timeout] && (typeof config[timeout] !== "number" || config[timeout] < 0)) {
			errors.push(`${timeout} must be a non-negative number`);
		}
	}

	// Validate buffer sizes
	const bufferSizes = ["bufferSize", "chunkSize"];
	for (const size of bufferSizes) {
		if (config[size] && (typeof config[size] !== "number" || config[size] < 1024)) {
			errors.push(`${size} must be a number >= 1024`);
		}
	}

	return {
		valid: errors.length === 0,
		errors
	};
}
