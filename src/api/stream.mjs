/**
 *	@Project: @cldmv/droidsock
 *	@Filename: /src/api/stream.mjs
 *	@Date: 2025-11-21 12:32:04 -08:00 (1763757124)
 *	@Author: Nate Hyson <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Hyson <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-08-30 16:02:20 -07:00 (1788130940)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 */

/**
 * ADB Stream management API module for DroidSock
 */

import { self } from "@cldmv/slothlet/runtime";
import { EventEmitter } from "node:events";

// ADB Protocol Constants
const MSG_OPEN = 0x4e45504f;
const MSG_WRTE = 0x45545257;
const MSG_CLSE = 0x45534c43;
const MSG_OKAY = 0x59414b4f;

/**
 * Gets command name from command code
 * @param {number} command - Command code
 * @returns {string} Command name
 */
function getCommandName(command) {
	switch (command) {
		case MSG_OPEN:
			return "OPEN";
		case MSG_WRTE:
			return "WRTE";
		case MSG_CLSE:
			return "CLSE";
		case MSG_OKAY:
			return "OKAY";
		default:
			return `0x${command.toString(16).toUpperCase()}`;
	}
}

/**
 * Creates a stream manager for handling ADB streams
 * @param {Object} socket - TCP socket
 * @returns {Object} Stream manager instance
 */
export function create(socket) {
	const streams = new Map();
	let nextStreamId = 1;
	const emitter = new EventEmitter();

	const manager = {
		socket,
		streams,

		// Device-initiated streams (e.g. a `reverse:forward:` tunnel's inbound
		// connections) aren't a response to anything droidsock opened, so
		// there's no promise/caller already waiting on them - subscribe via
		// on("remoteOpen", (stream, destination) => ...) instead.
		on: (...args) => emitter.on(...args),
		once: (...args) => emitter.once(...args),
		off: (...args) => emitter.off(...args),

		/**
		 * Opens a new ADB stream
		 * @param {string} destination - Stream destination (e.g., 'shell:')
		 * @returns {Promise<Object>} Stream object
		 */
		async openStream(destination) {
			const localId = nextStreamId++;
			const stream = new AdbStream(localId, 0, socket, manager);

			streams.set(localId, stream);

			// Send OPEN message
			const destBuffer = Buffer.from(destination);
			await sendMessage(socket, MSG_OPEN, localId, 0, destBuffer);

			// Wait for OKAY response
			return new Promise((resolve, reject) => {
				stream.once("ready", () => resolve(stream));
				stream.once("error", reject);

				// Timeout after 5 seconds
				setTimeout(() => {
					if (!stream.ready) {
						streams.delete(localId);
						reject(new Error("Stream open timeout"));
					}
				}, 5000);
			});
		},

		/**
		 * Handles incoming packets
		 * @param {Buffer} data - Raw packet data
		 */
		handlePacket(data) {
			let offset = 0;

			while (offset < data.length) {
				if (data.length - offset < 24) break; // Need at least header

				const command = data.readUInt32LE(offset);
				const arg0 = data.readUInt32LE(offset + 4);
				const arg1 = data.readUInt32LE(offset + 8);
				const dataLength = data.readUInt32LE(offset + 12);

				if (data.length - offset < 24 + dataLength) break; // Need full packet

				const packetData = data.slice(offset + 24, offset + 24 + dataLength);
				offset += 24 + dataLength;

				// Debug logging with directional arrows
				const commandName = getCommandName(command);
				if (self.config.get("debug")) {
					self.log.debug(`${self.config.get("debugArrowReceived")} ${commandName} arg0:${arg0} arg1:${arg1} len:${dataLength}`);
				}

				if (command === MSG_OPEN && arg1 === 0) {
					// Device-initiated: the far side is opening a NEW stream to us
					// (e.g. a peer connected to a device port that's registered via
					// `reverse:forward:`), not replying to something we opened -
					// arg0 is the device's own stream id for it, arg1 is always 0
					// (the device has no local id of ours to reference yet). Mint
					// one, ack it, and hand it to whoever's listening. A non-zero
					// arg1 on an OPEN isn't a shape the protocol defines - falls
					// through to normal per-stream routing below instead of being
					// misclassified as a new stream.
					const remoteId = arg0;
					const destination = packetData.toString("utf8");
					const localId = nextStreamId++;
					const stream = new AdbStream(localId, remoteId, socket, manager);
					stream.ready = true; // already open from our side - no OKAY to wait on
					streams.set(localId, stream);
					sendMessage(socket, MSG_OKAY, localId, remoteId);
					emitter.emit("remoteOpen", stream, destination);
					continue;
				}

				const stream = streams.get(arg1); // arg1 is local stream ID
				if (stream) {
					stream.handleMessage(command, arg0, arg1, packetData);
				}
			}
		},

		/**
		 * Closes a stream
		 * @param {number} streamId - Stream ID to close
		 */
		closeStream(streamId) {
			const stream = streams.get(streamId);
			if (stream) {
				try {
					stream.close();
				} finally {
					streams.delete(streamId);
				}
			}
		}
	};

	return manager;
}

/**
 * ADB Stream class
 */
class AdbStream extends EventEmitter {
	constructor(localId, remoteId, socket, manager) {
		super();
		this.localId = localId;
		this.remoteId = remoteId;
		this.socket = socket;
		this.manager = manager;
		this.ready = false;
		this.closed = false;
	}

	/**
	 * Handles incoming messages for this stream
	 * @param {number} command - Message command
	 * @param {number} arg0 - Remote stream ID
	 * @param {number} arg1 - Local stream ID
	 * @param {Buffer} data - Message data
	 */
	handleMessage(command, arg0, arg1, data) {
		switch (command) {
			case MSG_OKAY:
				if (!this.ready) {
					this.remoteId = arg0;
					this.ready = true;
					this.emit("ready");
				} else {
					// ACK for data we sent
					this.emit("ack");
				}
				break;

			case MSG_WRTE:
				this.emit("data", data);
				// Send ACK
				sendMessage(this.socket, MSG_OKAY, this.localId, this.remoteId);
				break;

			case MSG_CLSE:
				this.closed = true;
				this.emit("close");
				break;
		}
	}

	/**
	 * Writes data to the stream
	 * @param {Buffer|string} data - Data to write
	 * @returns {Promise<void>}
	 */
	async write(data) {
		if (this.closed || !this.ready) {
			throw new Error("Stream not ready or closed");
		}

		const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
		await sendMessage(this.socket, MSG_WRTE, this.remoteId, this.localId, buffer);
	}

	/**
	 * Closes the stream
	 */
	close() {
		if (!this.closed) {
			this.closed = true;
			sendMessage(this.socket, MSG_CLSE, this.remoteId, this.localId);
			this.emit("close");
		}
	}
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
	header.writeUInt32LE((command ^ 0xffffffff) >>> 0, offset);

	// Debug logging with directional arrows
	const commandName = getCommandName(command);
	if (self.config.get("debug")) {
		self.log.debug(`${self.config.get("debugArrowSent")} ${commandName} arg0:${arg0} arg1:${arg1} len:${data.length}`);
	}
	socket.write(header);
	if (data.length > 0) {
		socket.write(data);
	}
}

/**
 * Calculates ADB checksum
 * @param {Buffer} data - Data to checksum
 * @returns {number} Checksum value
 */
function checksum(data) {
	let sum = 0;
	for (let i = 0; i < data.length; i++) {
		sum += data[i];
	}
	return sum & 0xffffffff;
}
