/**
 *	@Project: @cldmv/droidsock
 *	@Filename: /src/api/utils.mjs
 *	@Date: 2025-11-21 12:19:49 -08:00 (1763756389)
 *	@Author: Nate Hyson <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Hyson <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-08-30 16:02:20 -07:00 (1788130940)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 */

/**
 * Utility functions API module for DroidSock
 */

/**
 * Parses Android property output into key-value pairs
 * @param {string} propOutput - Output from getprop command
 * @returns {Object} Parsed properties object
 */
export function parseProperties(propOutput) {
	const props = {};
	const lines = propOutput.split("\n");

	for (const line of lines) {
		const match = line.match(/^\[([^\]]+)\]:\s*\[([^\]]*)\]$/);
		if (match) {
			const [, key, value] = match;
			props[key] = value;
		}
	}

	return props;
}

/**
 * Parses ls -la output into structured data
 * @param {string} lsOutput - Output from ls -la command
 * @returns {Array} Array of file/directory objects
 */
export function parseListing(lsOutput) {
	const entries = [];
	const lines = lsOutput.split("\n").filter((line) => line.trim());

	// Skip the first line if it's a total
	const startIdx = lines[0]?.startsWith("total") ? 1 : 0;

	for (let i = startIdx; i < lines.length; i++) {
		const line = lines[i];
		const match = line.match(/^([drwx-]+)\s+(\d+)\s+(\w+)\s+(\w+)\s+(\d+)\s+(.+?)\s+(.+)$/);

		if (match) {
			const [, permissions, links, owner, group, size, dateTime, name] = match;

			entries.push({
				name,
				permissions,
				links: parseInt(links),
				owner,
				group,
				size: parseInt(size),
				dateTime,
				isDirectory: permissions.startsWith("d"),
				isFile: permissions.startsWith("-"),
				isSymlink: permissions.startsWith("l")
			});
		}
	}

	return entries;
}

/**
 * Parses battery status output
 * @param {string} batteryOutput - Output from dumpsys battery
 * @returns {Object} Parsed battery information
 */
export function parseBattery(batteryOutput) {
	const battery = {};
	const lines = batteryOutput.split("\n");

	for (const line of lines) {
		const match = line.match(/^\s*([^:]+):\s*(.+)$/);
		if (match) {
			let [, key, value] = match;
			key = key.trim();
			value = value.trim();

			// Convert numeric values
			if (/^\d+$/.test(value)) {
				value = parseInt(value);
			}

			battery[key] = value;
		}
	}

	return battery;
}

/**
 * Formats bytes into human-readable format
 * @param {number} bytes - Number of bytes
 * @param {number} [decimals=2] - Number of decimal places
 * @returns {string} Formatted string (e.g., "1.23 MB")
 */
export function formatBytes(bytes, decimals = 2) {
	if (bytes === 0) return "0 Bytes";

	const k = 1024;
	const dm = decimals < 0 ? 0 : decimals;
	const sizes = ["Bytes", "KB", "MB", "GB", "TB"];

	const i = Math.floor(Math.log(bytes) / Math.log(k));

	return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + " " + sizes[i];
}

/**
 * Waits for a specified amount of time
 * @param {number} ms - Milliseconds to wait
 * @returns {Promise<void>}
 */
export function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retries an async function with exponential backoff
 * @param {Function} fn - Async function to retry
 * @param {Object} [options={}] - Retry options
 * @param {number} [options.maxRetries=3] - Maximum number of retries. Negative values are clamped to 0 (fn still runs once) with a console.warn.
 * @param {number} [options.baseDelay=1000] - Base delay in ms
 * @param {number} [options.maxDelay=10000] - Maximum delay in ms
 * @param {Function} [options.shouldRetry] - Function to determine if error should be retried
 * @returns {Promise<any>} Result of the function
 */
export async function retry(fn, options = {}) {
	const { baseDelay = 1000, maxDelay = 10000, shouldRetry = () => true } = options;
	let { maxRetries = 3 } = options;

	if (maxRetries < 0) {
		console.warn(`retry: maxRetries must be >= 0, got ${maxRetries} - clamping to 0`);
		maxRetries = 0;
	}

	let lastError;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error;

			if (attempt === maxRetries || !shouldRetry(error)) {
				throw error;
			}

			const delayMs = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
			await delay(delayMs);
		}
	}

	throw lastError;
}

/**
 * Validates if a string is a valid IP address
 * @param {string} ip - IP address to validate
 * @returns {boolean} True if valid IP address
 */
export function isValidIP(ip) {
	const parts = ip.split(".");
	if (parts.length !== 4) return false;

	return parts.every((part) => {
		const num = parseInt(part, 10);
		return num >= 0 && num <= 255 && part === num.toString();
	});
}

/**
 * Validates if a port number is valid
 * @param {number} port - Port number to validate
 * @returns {boolean} True if valid port
 */
export function isValidPort(port) {
	return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * Parses a host:port string
 * @param {string} hostPort - Host:port string (e.g., "192.168.1.100:5555")
 * @param {number} [defaultPort=5555] - Default port if not specified
 * @returns {Object} Object with host and port properties
 */
export function parseHostPort(hostPort, defaultPort = 5555) {
	const colonIndex = hostPort.lastIndexOf(":");

	if (colonIndex === -1) {
		return { host: hostPort, port: defaultPort };
	}

	const host = hostPort.substring(0, colonIndex);
	const portStr = hostPort.substring(colonIndex + 1);
	const port = parseInt(portStr, 10);

	if (!isValidPort(port)) {
		throw new Error(`Invalid port: ${portStr}`);
	}

	return { host, port };
}

/**
 * Escapes shell special characters in a string
 * @param {string} str - String to escape
 * @returns {string} Escaped string
 */
export function escapeShell(str) {
	return str.replace(/[\\$`"]/g, "\\$&");
}

/**
 * Creates a timeout promise that rejects after specified time
 * @param {number} ms - Timeout in milliseconds
 * @param {string} [message='Operation timed out'] - Timeout error message
 * @returns {Promise<never>} Promise that rejects on timeout
 */
export function timeout(ms, message = "Operation timed out") {
	return new Promise((_, reject) => {
		setTimeout(() => reject(new Error(message)), ms);
	});
}

/**
 * Wraps a promise with a timeout
 * @param {Promise} promise - Promise to wrap
 * @param {number} ms - Timeout in milliseconds
 * @param {string} [message='Operation timed out'] - Timeout error message
 * @returns {Promise<any>} Promise that resolves/rejects with timeout
 */
export function withTimeout(promise, ms, message) {
	return Promise.race([promise, timeout(ms, message)]);
}
