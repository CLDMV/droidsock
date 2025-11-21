/**
 *	@Project: @cldmv/droidsock
 *	@Filename: /src/api/shell.mjs
 *	@Date: 2025-11-21 12:18:40 -08:00 (1763756320)
 *	@Author: Nate Hyson <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Hyson <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2025-11-21 14:05:16 -08:00 (1763762716)
 *	-----
 *	@Copyright: Copyright (c) 2013-2025 Catalyzed Motivation Inc. All rights reserved.
 */

/**
 * Shell command execution API module for DroidSock
 */

import { self, context } from "@cldmv/slothlet/runtime";

/**
 * Executes a shell command and returns the output
 * @param {Object} socket - ADB socket
 * @param {Object} streamManager - Stream manager instance
 * @param {string} command - Shell command to execute
 * @param {Object} [options={}] - Execution options
 * @param {number} [options.timeout=30000] - Command timeout in ms
 * @param {string} [options.encoding='utf8'] - Output encoding
 * @returns {Promise<string>} Command output
 */
export async function execute(socket, streamManager, command, options = {}) {
	const { timeout = 30000, encoding = "utf8", deviceFeatures = [] } = options;

	return new Promise(async (resolve, reject) => {
		try {
			let output = Buffer.alloc(0);
			let streamId = null;
			let commandTimeout;
			let commandCompleted = false;

			// Determine shell protocol based on device features
			let protocolUsed;
			const supportsShellV2 = deviceFeatures.includes("shell_v2");

			if (supportsShellV2) {
				protocolUsed = `shell,v2:${command}`;
			} else {
				protocolUsed = `shell:${command}`;
			}

			if (self.config.get("debug")) {
				self.log.debug(`Executing shell command: ${protocolUsed}`);
			}

			// Create OPEN packet for shell command (like reference script)
			const destBuffer = Buffer.from(protocolUsed);
			const openPacket = Buffer.alloc(24 + destBuffer.length);
			openPacket.writeUInt32LE(0x4e45504f, 0); // OPEN command
			openPacket.writeUInt32LE(12345, 4); // local stream ID
			openPacket.writeUInt32LE(0, 8); // arg1 = 0
			openPacket.writeUInt32LE(destBuffer.length, 12); // data length

			// Calculate checksum
			let checksum = 0;
			for (let i = 0; i < destBuffer.length; i++) {
				checksum += destBuffer[i];
			}
			openPacket.writeUInt32LE(checksum & 0xffffffff, 16);

			// Magic = ~command
			openPacket.writeUInt32LE(~0x4e45504f >>> 0, 20);

			// Append data
			destBuffer.copy(openPacket, 24);

			socket.write(openPacket);

			// Set timeout for command execution
			commandTimeout = setTimeout(() => {
				if (!commandCompleted) {
					commandCompleted = true;
					socket.removeAllListeners("data");
					reject(new Error(`Command timeout: ${command}`));
				}
			}, timeout);

			// The problem is that we're competing with the streamManager for socket data
			// Instead, let's temporarily hijack the socket's data handler during shell execution
			let responseBuffer = Buffer.alloc(0);
			let originalHandlers = [];

			// Store and remove existing data handlers
			const existingHandlers = socket.listeners("data");
			existingHandlers.forEach((handler) => {
				socket.removeListener("data", handler);
				originalHandlers.push(handler);
			});

			// Handle responses directly (like reference script)
			const dataHandler = (chunk) => {
				if (commandCompleted) return;

				responseBuffer = Buffer.concat([responseBuffer, chunk]);

				// Process packets
				while (responseBuffer.length >= 24) {
					const cmd = responseBuffer.readUInt32LE(0);
					const arg0 = responseBuffer.readUInt32LE(4);
					const arg1 = responseBuffer.readUInt32LE(8);
					const dataLength = responseBuffer.readUInt32LE(12);

					if (responseBuffer.length < 24 + dataLength) break;

					const packetData = dataLength > 0 ? responseBuffer.slice(24, 24 + dataLength) : null;
					responseBuffer = responseBuffer.slice(24 + dataLength);

					if (self.config.get("debug")) {
						const commandName =
							cmd === 0x59414b4f ? "OKAY" : cmd === 0x45545257 ? "WRTE" : cmd === 0x45534c43 ? "CLSE" : `0x${cmd.toString(16)}`;
						self.log.debug(`${self.config.get("debugArrowReceived")} ${commandName} arg0:${arg0} arg1:${arg1} len:${dataLength}`);
					}

					if (cmd === 0x59414b4f && !streamId) {
						// OKAY - stream opened
						streamId = arg1;
						if (self.config.get("debug")) {
							self.log.debug(`Shell stream opened with ID: ${streamId}`);
						}
					} else if (cmd === 0x45545257 && arg1 === 12345) {
						// WRTE - data from device
						if (packetData) {
							output = Buffer.concat([output, packetData]);
							if (self.config.get("debug")) {
								self.log.debug(`Received ${packetData.length} bytes of output`);
							}
						}
					} else if (cmd === 0x45534c43 && arg1 === 12345) {
						// CLSE - stream closed
						if (self.config.get("debug")) {
							self.log.debug("Shell stream closed by device");
						}
						commandCompleted = true;
						clearTimeout(commandTimeout);
						socket.removeListener("data", dataHandler);

						// Restore original handlers
						originalHandlers.forEach((handler) => {
							socket.on("data", handler);
						});

						resolve(output.toString(encoding));
						return;
					}
				}
			};

			socket.on("data", dataHandler);
		} catch (error) {
			reject(error);
		}
	});
}

/**
 * Starts a streaming shell command
 * @param {Object} socket - ADB socket
 * @param {Object} streamManager - Stream manager instance
 * @param {string} command - Shell command
 * @param {Object} [options={}] - Options
 * @param {Function} [options.onData] - Data callback
 * @param {Function} [options.onError] - Error callback
 * @param {Function} [options.onEnd] - End callback
 * @returns {Object} Control object with stop() method
 */
export function startStreaming(socket, streamManager, command, options = {}) {
	const { onData, onError, onEnd } = options;
	let stream = null;

	const control = {
		stop() {
			if (stream) {
				stream.close();
				stream = null;
			}
		}
	};

	// Start the stream asynchronously
	(async () => {
		try {
			stream = await streamManager.openStream(`shell:${command}`);

			stream.on("data", (data) => {
				if (onData) onData(data.toString());
			});

			stream.on("close", () => {
				if (onEnd) onEnd();
			});

			stream.on("error", (error) => {
				if (onError) onError(error);
			});
		} catch (error) {
			if (onError) onError(error);
		}
	})();

	return control;
}

/**
 * Starts an interactive shell command
 * @param {Object} socket - ADB socket
 * @param {Object} streamManager - Stream manager instance
 * @param {string} command - Command to execute
 * @param {Object} [options={}] - Options
 * @param {Function} [options.onData] - Data callback
 * @param {Function} [options.onError] - Error callback
 * @param {Function} [options.onEnd] - End callback
 * @returns {Object} Control object with sendInput() and stop() methods
 */
export function startInteractive(socket, streamManager, command, options = {}) {
	const { onData, onError, onEnd } = options;
	let stream = null;

	const control = {
		async sendInput(input) {
			if (stream) {
				await stream.write(input);
			}
		},

		stop() {
			if (stream) {
				stream.close();
				stream = null;
			}
		}
	};

	// Start the stream asynchronously
	(async () => {
		try {
			stream = await streamManager.openStream(`shell:${command}`);

			stream.on("data", (data) => {
				if (onData) onData(data.toString());
			});

			stream.on("close", () => {
				if (onEnd) onEnd();
			});

			stream.on("error", (error) => {
				if (onError) onError(error);
			});
		} catch (error) {
			if (onError) onError(error);
		}
	})();

	return control;
}

/**
 * Common shell command shortcuts
 */
export const commands = {
	/**
	 * List directory contents
	 * @param {Object} socket - ADB socket
	 * @param {Object} streamManager - Stream manager
	 * @param {string} [path='.'] - Directory path
	 * @returns {Promise<string>} Directory listing
	 */
	ls: async (socket, streamManager, path = ".") => {
		return await execute(socket, streamManager, `ls -la "${path}"`);
	},

	/**
	 * Get current working directory
	 * @param {Object} socket - ADB socket
	 * @param {Object} streamManager - Stream manager
	 * @returns {Promise<string>} Current directory
	 */
	pwd: async (socket, streamManager) => {
		return await execute(socket, streamManager, "pwd");
	},

	/**
	 * Get system properties
	 * @param {Object} socket - ADB socket
	 * @param {Object} streamManager - Stream manager
	 * @param {string} [prop] - Specific property name
	 * @returns {Promise<string>} Property value(s)
	 */
	getprop: async (socket, streamManager, prop = null) => {
		const cmd = prop ? `getprop "${prop}"` : "getprop";
		return await execute(socket, streamManager, cmd);
	},

	/**
	 * Get device model
	 * @param {Object} socket - ADB socket
	 * @param {Object} streamManager - Stream manager
	 * @returns {Promise<string>} Device model
	 */
	getModel: async (socket, streamManager) => {
		return await execute(socket, streamManager, "getprop ro.product.model");
	},

	/**
	 * Get Android version
	 * @param {Object} socket - ADB socket
	 * @param {Object} streamManager - Stream manager
	 * @returns {Promise<string>} Android version
	 */
	getAndroidVersion: async (socket, streamManager) => {
		return await execute(socket, streamManager, "getprop ro.build.version.release");
	},

	/**
	 * Get battery information
	 * @param {Object} socket - ADB socket
	 * @param {Object} streamManager - Stream manager
	 * @returns {Promise<string>} Battery info
	 */
	getBattery: async (socket, streamManager) => {
		return await execute(socket, streamManager, "dumpsys battery");
	},

	/**
	 * Take screenshot
	 * @param {Object} socket - ADB socket
	 * @param {Object} streamManager - Stream manager
	 * @param {string} [filename='/sdcard/screenshot.png'] - Output filename
	 * @returns {Promise<string>} Command result
	 */
	screenshot: async (socket, streamManager, filename = "/sdcard/screenshot.png") => {
		return await execute(socket, streamManager, `screencap -p "${filename}"`);
	},

	/**
	 * Start logcat streaming
	 * @param {Object} socket - ADB socket
	 * @param {Object} streamManager - Stream manager
	 * @param {Object} [options={}] - Streaming options
	 * @returns {Object} Control object with stop() method
	 */
	logcat: (socket, streamManager, options = {}) => {
		return startStreaming(socket, streamManager, "logcat", options);
	},

	/**
	 * Start top command streaming
	 * @param {Object} socket - ADB socket
	 * @param {Object} streamManager - Stream manager
	 * @param {Object} [options={}] - Streaming options
	 * @returns {Object} Control object with stop() method
	 */
	top: (socket, streamManager, options = {}) => {
		return startStreaming(socket, streamManager, "top -m 10", options);
	},

	/**
	 * Send keypress event
	 * @param {Object} socket - ADB socket
	 * @param {Object} streamManager - Stream manager
	 * @param {string|number} key - Key code or name
	 * @returns {Promise<string>} Command result
	 */
	keypress: async (socket, streamManager, key) => {
		return await execute(socket, streamManager, `input keyevent ${key}`);
	},

	/**
	 * Launch application
	 * @param {Object} socket - ADB socket
	 * @param {Object} streamManager - Stream manager
	 * @param {string} packageName - Package name
	 * @param {string} [activity=''] - Activity name
	 * @returns {Promise<string>} Command result
	 */
	launchApp: async (socket, streamManager, packageName, activity = "") => {
		const activityArg = activity ? `/${activity}` : "";
		return await execute(socket, streamManager, `am start -n ${packageName}${activityArg}`);
	},

	/**
	 * Kill application
	 * @param {Object} socket - ADB socket
	 * @param {Object} streamManager - Stream manager
	 * @param {string} packageName - Package name
	 * @returns {Promise<string>} Command result
	 */
	killApp: async (socket, streamManager, packageName) => {
		return await execute(socket, streamManager, `am force-stop ${packageName}`);
	},

	/**
	 * Install APK
	 * @param {Object} socket - ADB socket
	 * @param {Object} streamManager - Stream manager
	 * @param {string} apkPath - Path to APK file on device
	 * @param {Array<string>} [flags=[]] - Installation flags
	 * @returns {Promise<string>} Installation result
	 */
	installApk: async (socket, streamManager, apkPath, flags = []) => {
		const flagsStr = flags.length > 0 ? ` ${flags.join(" ")}` : "";
		return await execute(socket, streamManager, `pm install${flagsStr} "${apkPath}"`);
	},

	/**
	 * Uninstall package
	 * @param {Object} socket - ADB socket
	 * @param {Object} streamManager - Stream manager
	 * @param {string} packageName - Package name
	 * @returns {Promise<string>} Uninstall result
	 */
	uninstallApp: async (socket, streamManager, packageName) => {
		return await execute(socket, streamManager, `pm uninstall ${packageName}`);
	}
};
