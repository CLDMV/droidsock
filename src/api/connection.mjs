/**
 *	@Project: @cldmv/droidsock
 *	@Filename: /src/api/connection.mjs
 *	@Date: 2025-11-21 12:30:43 -08:00 (1763757043)
 *	@Author: Nate Hyson <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Hyson <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2025-11-21 14:05:52 -08:00 (1763762752)
 *	-----
 *	@Copyright: Copyright (c) 2013-2025 Catalyzed Motivation Inc. All rights reserved.
 */

/**
 * ADB Connection API module for DroidSock
 */

import { self, context } from "@cldmv/slothlet/runtime";
import net from "node:net";
import crypto from "node:crypto";

// ADB Protocol Constants
const ADB_PROTOCOL_VERSION = 0x01000000;
const ADB_MAX_PAYLOAD = 4096;

// Message types
const MSG_CNXN = 0x4e584e43;
const MSG_AUTH = 0x48545541;
const MSG_OKAY = 0x59414b4f;

/**
 * Creates an ADB connection to a device
 * @param {Object} options - Connection options
 * @param {string} options.host - Device host/IP
 * @param {number} options.port - Device port
 * @param {string} options.publicKey - RSA public key
 * @param {string} options.privateKey - RSA private key
 * @param {string} options.adbPublicKey - ADB-formatted public key
 * @returns {Promise<Object>} Connection object
 */
export async function create(options) {
	const { host, port, publicKey, privateKey, adbPublicKey } = options;
	const { config, logger } = context;

	const socket = new net.Socket();
	const connection = {
		socket,
		host,
		port,
		authorized: false,
		connected: false,
		onUnhandledPacket: null,

		// Add disconnect method
		disconnect: () => {
			if (socket && !socket.destroyed) {
				self.log.debug(`Disconnecting from ${host}:${port}`);
				socket.destroy();
			}
			connection.connected = false;
			connection.authorized = false;
		}
	};

	return new Promise((resolve, reject) => {
		// Add connection timeout
		const timeout = setTimeout(() => {
			socket.destroy();
			reject(new Error("Connection timeout"));
		}, 10000);

		socket.connect(port, host, async () => {
			try {
				self.log.debug(`Connected to ${host}:${port}, sending CNXN message...`);

				// Send CNXN message
				const systemIdentity = "device::";
				const cnxnPayload = Buffer.from(systemIdentity);
				await sendMessage(socket, MSG_CNXN, ADB_PROTOCOL_VERSION, ADB_MAX_PAYLOAD, cnxnPayload);

				self.log.debug(`${self.config.get("debugArrowSent")} CNXN message sent, waiting for AUTH response...`);

				// Wait for AUTH message
				const authMessage = await receiveMessage(socket);
				self.log.debug(`${self.config.get("debugArrowReceived")} Received AUTH message, command:`, authMessage.command.toString(16));

				if (authMessage.command !== MSG_AUTH) {
					throw new Error(`Expected AUTH message (0x${MSG_AUTH.toString(16)}), got 0x${authMessage.command.toString(16)}`);
				}

				self.log.debug(`${self.config.get("debugArrowReceived")} AUTH message received, token length:`, authMessage.data.length);

				// Sign the token using self.auth
				const token = authMessage.data;
				const signature = await self.auth.sign(token, privateKey);

				// Send signature
				await sendMessage(socket, MSG_AUTH, 2, 0, signature);

				// Send public key
				const pubKeyBuffer = Buffer.from(adbPublicKey);
				await sendMessage(socket, MSG_AUTH, 3, 0, pubKeyBuffer);

				// Wait for OKAY
				const okayMessage = await receiveMessage(socket);
				self.log.debug(`${self.config.get("debugArrowReceived")} After auth, received command:`, okayMessage.command.toString(16));
				self.log.debug("Expected CNXN:", MSG_CNXN.toString(16), "or OKAY:", MSG_OKAY.toString(16));

				if (okayMessage.command === MSG_CNXN) {
					// Device sent CNXN back - this is the expected successful authentication response
					const cnxnPayload = okayMessage.data.toString().replace(/\0/g, "");
					self.log.debug(`${self.config.get("debugArrowReceived")} Device sent CNXN response - authentication successful!`);
					self.log.debug(`${self.config.get("debugArrowReceived")} CNXN payload:`, cnxnPayload);

					// Parse device features from CNXN payload
					const featuresMatch = cnxnPayload.match(/features=([^;]+)/);
					connection.deviceFeatures = featuresMatch ? featuresMatch[1].split(",") : [];

					connection.authorized = true;
					connection.connected = true;
					self.log.debug("Authentication successful!");
				} else if (okayMessage.command === MSG_OKAY) {
					self.log.debug(`${self.config.get("debugArrowReceived")} Device sent OKAY response - authentication successful!`);
					connection.authorized = true;
					connection.connected = true;
				} else {
					throw new Error(
						`Authentication failed - expected CNXN (${MSG_CNXN.toString(16)}) or OKAY (${MSG_OKAY.toString(16)}), got ${okayMessage.command.toString(16)}`
					);
				}
				clearTimeout(timeout);

				// Set up packet handling
				socket.on("data", (data) => {
					if (connection.onUnhandledPacket) {
						// Parse and forward to stream manager
						connection.onUnhandledPacket(data);
					}
				});

				resolve(connection);
			} catch (error) {
				clearTimeout(timeout);
				self.log.debug("Connection error:", error.message);
				reject(error);
			}
		});

		socket.on("error", (error) => {
			clearTimeout(timeout);
			self.log.debug("Socket error:", error.message);
			reject(error);
		});
	});
}

/**
 * Sends an ADB protocol message
 * @param {Object} socket - TCP socket
 * @param {number} command - Message command
 * @param {number} arg0 - First argument
 * @param {number} arg1 - Second argument
 * @param {Buffer} data - Message data
 */
async function sendMessage(socket, command, arg0, arg1, data = Buffer.alloc(0)) {
	const header = Buffer.alloc(24);
	let offset = 0;

	header.writeUInt32LE(command, offset);
	offset += 4;
	header.writeUInt32LE(arg0, offset);
	offset += 4;
	header.writeUInt32LE(arg1, offset);
	offset += 4;
	header.writeUInt32LE(data.length, offset);
	offset += 4;
	header.writeUInt32LE(checksum(data), offset);
	offset += 4;
	header.writeUInt32LE((command ^ 0xffffffff) >>> 0, offset); // Ensure unsigned 32-bit

	socket.write(header);
	if (data.length > 0) {
		socket.write(data);
	}
}

/**
 * Receives an ADB protocol message
 * @param {Object} socket - TCP socket
 * @returns {Promise<Object>} Parsed message
 */
function receiveMessage(socket) {
	return new Promise((resolve, reject) => {
		let headerReceived = false;
		let expectedDataLength = 0;
		let receivedHeader = null;
		let receivedData = Buffer.alloc(0);

		const onData = (chunk) => {
			if (!headerReceived) {
				if (chunk.length >= 24) {
					receivedHeader = chunk.slice(0, 24);

					// Debug header content
					self.log.debug(
						"Header bytes:",
						Array.from(receivedHeader)
							.map((b) => b.toString(16).padStart(2, "0"))
							.join(" ")
					);

					// Read and validate data length
					try {
						expectedDataLength = receivedHeader.readUInt32LE(12);
						self.log.debug("Raw data length from header:", expectedDataLength);
					} catch (readError) {
						reject(new Error(`Failed to read data length from header: ${readError.message}`));
						return;
					}

					// Validate data length
					if (isNaN(expectedDataLength) || expectedDataLength < 0 || expectedDataLength > 1024 * 1024) {
						reject(new Error(`Invalid data length: ${expectedDataLength} (header: ${receivedHeader.toString("hex")})`));
						return;
					}

					headerReceived = true;

					if (chunk.length > 24) {
						receivedData = Buffer.concat([receivedData, chunk.slice(24)]);
					}
				}
			} else {
				receivedData = Buffer.concat([receivedData, chunk]);
			}

			if (headerReceived && receivedData.length >= expectedDataLength) {
				socket.removeListener("data", onData);

				try {
					const command = receivedHeader.readUInt32LE(0);
					const arg0 = receivedHeader.readUInt32LE(4);
					const arg1 = receivedHeader.readUInt32LE(8);
					const dataLength = receivedHeader.readUInt32LE(12);
					const headerChecksum = receivedHeader.readUInt32LE(16);
					const magic = receivedHeader.readUInt32LE(20);

					self.log.debug(
						"Parsed header - command:",
						command.toString(16),
						"arg0:",
						arg0,
						"arg1:",
						arg1,
						"length:",
						dataLength,
						"checksum:",
						headerChecksum,
						"magic:",
						magic.toString(16)
					);

					// Validate magic (should be command ^ 0xFFFFFFFF)
					const expectedMagic = (command ^ 0xffffffff) >>> 0;
					if (magic !== expectedMagic) {
						self.log.debug("Magic mismatch - expected:", expectedMagic.toString(16), "got:", magic.toString(16));
					}

					const data = receivedData.slice(0, expectedDataLength);

					// Validate checksum if we have data
					if (data.length > 0) {
						const calculatedChecksum = checksum(data);
						self.log.debug("Data checksum - expected:", headerChecksum, "calculated:", calculatedChecksum);
					}

					resolve({ command, arg0, arg1, data });
				} catch (parseError) {
					reject(new Error(`Failed to parse message header: ${parseError.message}`));
				}
			}
		};

		socket.on("data", onData);
		socket.on("error", reject);
	});
}

/**
 * Calculates ADB checksum
 * @param {Buffer} data - Data to checksum
 * @returns {number} Checksum value
 */
function checksum(data) {
	let sum = 0;
	for (let i = 0; i < data.length; i++) {
		sum = (sum + data[i]) >>> 0; // Ensure unsigned 32-bit arithmetic
	}
	return sum;
}
