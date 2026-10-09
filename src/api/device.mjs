/**
 *
 *	@Project: @cldmv/droidsock
 *	@Filename: /src/api/device.mjs
 *	@Date: 2025-11-21T12:18:12-08:00 (1763756292)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-02T15:29:45-07:00 (1790980185)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/**
 * Single-device connection API module for DroidSock.
 *
 * connect()/disconnect()/remove() are the single-target operations - the
 * module name disambiguates them from the collection-wide operations on
 * self.devices (list/disconnect/remove/get, see devices.mjs).
 *
 * A device leaf, once created, is a persistent handle that outlives any one
 * TCP connection: disconnect() only tears down the current socket (cheap,
 * synchronous - there's no api-tree work left to do), it does NOT unmount
 * the leaf. connect() on an already-known (but disconnected) host:port
 * reconnects that SAME leaf in place - reusing its remembered options
 * (see reconnect() below) - rather than building a new one, so a reference
 * you're already holding (or a caller looking it up later via devices.get())
 * stays valid across a disconnect/reconnect cycle. remove() is the separate,
 * explicit "forget this device" operation - it disconnects (if needed) and
 * unmounts the leaf, which IS real api-tree surgery and therefore the one
 * genuinely async step in this lifecycle.
 *
 * Every connected-or-previously-connected device lives on this module's own
 * slothlet namespace (self.devices / api.devices) as a real,
 * individually-addressable leaf (mounted via api.slothlet.api.add(),
 * docs/RELOAD.md) - only the module that starts/ends/forgets a single
 * connection lives here; the leaf itself is always reachable at
 * `devices.<sanitized host_port>` regardless of which module mounted,
 * disconnected, or removed it. self access inside a device's methods works
 * correctly on every call because they're genuine tree leaves invoked
 * through the normal apply-trap path - unlike a plain object returned from an
 * async function (which depends on slothlet's class-instance
 * context-preservation mechanism, and that mechanism never actually fires
 * for an async function's return value - see the linked issue below), and
 * unlike a plain `self.devices[key] = <object>` assignment (slothlet's
 * documented "wrap-on-set" behavior, CONTEXT-PROPAGATION.md - empirically
 * this does NOT give the assigned object's methods working self access the
 * way add() does, despite the doc describing it as using "the same wrapper
 * construction").
 */

import { EventEmitter } from "node:events";
import { self } from "@cldmv/slothlet/runtime";
import { quoteShellArg, sanitizeKey } from "./utils.mjs";

/**
 * Defaults for `options.autoReconnect` when it is `true` or an object. `initialDelay` falls back to the
 * `retryDelay` config value when not given.
 */
const DEFAULT_RECONNECT_POLICY = { maxAttempts: Infinity, maxDelay: 30000, factor: 2, jitter: 0.2 };

/**
 * Resolves `options.autoReconnect` into a concrete reconnect policy.
 * @param {boolean|Object} [autoReconnect] - `false`/unset disables it; `true` uses the defaults; an object overrides them.
 * @param {number} [autoReconnect.maxAttempts=Infinity] - Consecutive failed attempts before emitting `gave-up`.
 * @param {number} [autoReconnect.initialDelay] - Delay before the first attempt in ms (default: the `retryDelay` config value).
 * @param {number} [autoReconnect.maxDelay=30000] - Upper bound for the backoff delay in ms.
 * @param {number} [autoReconnect.factor=2] - Multiplier applied to the delay after each failed attempt.
 * @param {number} [autoReconnect.jitter=0.2] - Fraction (0-1) of the delay randomised either way, so a fleet of clients does not retry in lockstep.
 * @returns {Object|null} The policy, or null when auto-reconnect is off.
 */
function resolveReconnectPolicy(autoReconnect) {
	if (!autoReconnect) return null;
	const custom = typeof autoReconnect === "object" ? autoReconnect : {};
	return { ...DEFAULT_RECONNECT_POLICY, initialDelay: self.config.get("retryDelay", 1000), ...custom };
}

/**
 * Backoff delay for a given (1-based) attempt: `initialDelay * factor^(attempt-1)`, capped at `maxDelay`, then jittered.
 * @param {Object} policy - A policy from resolveReconnectPolicy().
 * @param {number} attempt - 1-based attempt number.
 * @returns {number} Delay in milliseconds.
 */
function backoffDelay(policy, attempt) {
	const base = Math.min(policy.maxDelay, policy.initialDelay * policy.factor ** (attempt - 1));
	const spread = base * policy.jitter;
	return Math.max(0, Math.round(base - spread + Math.random() * spread * 2));
}

/**
 * Resolves `options.heartbeat` into a concrete probe policy.
 * @param {boolean|Object} [heartbeat] - `false`/unset disables it; `true` uses the defaults; an object overrides them.
 * @param {number} [heartbeat.interval=15000] - Milliseconds between probes.
 * @param {number} [heartbeat.timeout=5000] - Milliseconds a probe may take before the connection is declared dead.
 * @returns {Object|null} The policy, or null when the heartbeat is off.
 */
function resolveHeartbeatPolicy(heartbeat) {
	if (!heartbeat) return null;
	return { interval: 15000, timeout: 5000, ...(typeof heartbeat === "object" ? heartbeat : {}) };
}

/**
 * True for a failure that retrying cannot fix (the device rejected authentication).
 * @param {Error} error - The error from a failed connection attempt.
 * @returns {boolean} Whether to stop retrying.
 */
function isFatalConnectError(error) {
	return /^Authentication failed/.test(error?.message || "");
}

/**
 * Establishes one TCP connection + stream manager for a device and wires up
 * packet routing - the actual protocol-level work shared by both the first
 * connect() and every later reconnect() of the same leaf.
 * @param {string} host - Device host/IP address
 * @param {number} port - Device port
 * @param {Object} options - Connection options
 * @param {string} [options.keyDir] - Directory for RSA keys (default: ~/.adb)
 * @returns {Promise<{connection: Object, streamManager: Object}>} The new session pair.
 */
async function openSession(host, port, options) {
	const keys = await self.auth.getKeys(options.keyDir);
	const connection = await self.connection.create({
		host,
		port,
		publicKey: keys.publicKey,
		privateKey: keys.privateKey,
		adbPublicKey: keys.adbPublicKey
	});
	const streamManager = await self.stream.create(connection.socket);
	connection.onUnhandledPacket = (packet) => streamManager.handlePacket(packet);
	return { connection, streamManager };
}

/**
 * Builds the per-device leaf object assigned onto self.devices[key]. Every
 * function here becomes a real, individually-wrapped slothlet leaf once
 * assigned - see the module doc comment above.
 *
 * Every method reads the connection/stream manager off `session` - a plain
 * object private to this closure, never passed through add()'s flatten+wrap
 * pipeline - rather than off a data property of the mounted leaf itself.
 * That indirection is required, not stylistic: slothlet's mount pipeline
 * does not preserve object identity between the raw object passed to add()
 * and what self.devices[deviceKey] resolves to afterward (functions ARE
 * correctly proxied through to their real closures either way - only a
 * plain-data-property write/read through the wrapper is unreliable). So a
 * write to `self.devices[deviceKey].connection` would never be visible to a
 * closure that reads `leaf.connection` - it has to read a value that was
 * never touched by that pipeline at all. `leaf.connection`/
 * `leaf.streamManager` still exist as a best-effort EXTERNAL mirror (for
 * callers/tests that read `device.connection.socket`, per docs/API.md), but
 * nothing in this file relies on them internally - reconnect() is the only
 * place that writes them, and it does so through `self.devices[deviceKey]`
 * specifically (see its comment) rather than through `leaf` directly.
 * @param {string} host - Device host/IP address
 * @param {number} port - Device port
 * @param {string} deviceId - `${host}:${port}`
 * @param {string} deviceKey - Sanitized api-path segment for this device
 * @param {Object} options - The connect() options this leaf was created with, remembered for reconnect().
 * @returns {Object} The device leaf
 */
function buildDeviceLeaf(host, port, deviceId, deviceKey, options) {
	const session = { connection: null, streamManager: null };

	// Lifecycle state. Everything here lives in this closure (never on the mounted leaf) for the same
	// reason `session` does - see the doc comment above.
	const emitter = new EventEmitter();
	const closedByUs = new WeakSet(); // connections torn down by disconnect()/remove(), so their close is not a drop
	const closeReasons = new WeakMap(); // connection -> why droidsock itself closed it (e.g. "heartbeat")
	let reconnectTimer = null;
	let heartbeatTimer = null;
	let inflight = null;

	/**
	 * Emits a lifecycle event (no-op when the `emitEvents` config is off). A throwing listener is logged rather than
	 * propagated, so it can't take down the socket handler that fired the event; `error` is only emitted when
	 * something is listening, since an unhandled EventEmitter `error` would throw.
	 * @param {string} event - Event name.
	 * @param {Object} [detail={}] - Event payload; `deviceId`, `host` and `port` are added.
	 */
	function emit(event, detail = {}) {
		if (!self.config.get("emitEvents", true)) return;
		if (event === "error" && emitter.listenerCount("error") === 0) return;
		try {
			emitter.emit(event, { deviceId, host, port, ...detail });
		} catch (listenerError) {
			self.log.error(`Listener for "${event}" on ${deviceId} threw:`, listenerError);
		}
	}

	function stopHeartbeat() {
		if (heartbeatTimer) clearInterval(heartbeatTimer);
		heartbeatTimer = null;
	}

	/**
	 * Starts the optional heartbeat for a connection: ADB has no ping message, so each probe is a trivial shell
	 * command whose round trip proves the device is still answering. A probe that fails or times out closes the
	 * socket, which surfaces as `disconnected` (reason "heartbeat") and, with autoReconnect on, a reconnect.
	 * @param {Object} connection - The connection to watch.
	 */
	function startHeartbeat(connection) {
		stopHeartbeat();
		const policy = resolveHeartbeatPolicy(leaf.options.heartbeat);
		if (!policy) return;
		let probing = false;
		heartbeatTimer = setInterval(async () => {
			if (probing || session.connection !== connection || !leaf.isConnected()) return;
			probing = true;
			try {
				await self.shell.execute(connection.socket, session.streamManager, "echo", {
					timeout: policy.timeout,
					deviceFeatures: connection.deviceFeatures || []
				});
			} catch (error) {
				if (session.connection === connection) {
					closeReasons.set(connection, "heartbeat");
					emit("error", { error });
					connection.disconnect();
				}
			} finally {
				probing = false;
			}
		}, policy.interval);
	}

	function cancelReconnect() {
		if (reconnectTimer) clearTimeout(reconnectTimer);
		reconnectTimer = null;
	}

	/**
	 * Opens a session and mirrors it onto the mounted leaf. Concurrent callers share one attempt.
	 * @param {string} [phase="connect"] - "connect" or "reconnect", for the lifecycle events.
	 * @returns {Promise<void>}
	 */
	function establish(phase = "connect") {
		if (inflight) return inflight;
		inflight = (async () => {
			emit("connecting", { phase });
			const { connection, streamManager } = await openSession(host, port, leaf.options);
			session.connection = connection;
			session.streamManager = streamManager;
			self.devices[deviceKey].connection = connection;
			self.devices[deviceKey].streamManager = streamManager;
			watchConnection(connection);
			startHeartbeat(connection);
			emit("connected", { phase });
		})().finally(() => {
			inflight = null;
		});
		return inflight;
	}

	/**
	 * Turns on TCP keepalive (per the `keepAlive`/`keepAliveInterval` config) and reports when the socket closes.
	 * @param {Object} connection - The connection returned by openSession().
	 */
	function watchConnection(connection) {
		const socket = connection.socket;
		if (self.config.get("keepAlive", true)) socket.setKeepAlive(true, self.config.get("keepAliveInterval", 30000));
		socket.once("close", (hadError) => {
			// A connection already replaced by a newer session is history, not a drop.
			if (session.connection !== connection) return;
			connection.connected = false;
			stopHeartbeat();
			const intentional = closedByUs.has(connection);
			emit("disconnected", { intentional, hadError, reason: closeReasons.get(connection) ?? (intentional ? "requested" : "closed") });
			if (!intentional) scheduleReconnect(1);
		});
	}

	/**
	 * Schedules the next automatic reconnect attempt with exponential backoff, or emits `gave-up`.
	 * @param {number} attempt - 1-based attempt number.
	 * @param {Error} [lastError] - Why the previous attempt failed.
	 */
	function scheduleReconnect(attempt, lastError) {
		const policy = resolveReconnectPolicy(leaf.options.autoReconnect);
		if (!policy) return;
		if (attempt > policy.maxAttempts) {
			emit("gave-up", { reason: "max-attempts", attempts: attempt - 1, error: lastError });
			return;
		}
		const delay = backoffDelay(policy, attempt);
		emit("reconnecting", { attempt, delay, error: lastError });
		reconnectTimer = setTimeout(async () => {
			reconnectTimer = null;
			try {
				await establish("reconnect");
				emit("reconnected", { attempt });
			} catch (error) {
				emit("error", { error, attempt });
				if (isFatalConnectError(error)) emit("gave-up", { reason: "auth", attempts: attempt, error });
				else scheduleReconnect(attempt + 1, error);
			}
		}, delay);
	}

	/**
	 * Throws if this device isn't connected and authorized. Shared guard for every method below.
	 */
	function assertReady() {
		if (!leaf.isConnected()) {
			throw new Error("Device not connected");
		}
		if (!session.connection.authorized) {
			throw new Error("Device not authorized. Please accept authorization dialog.");
		}
	}

	const leaf = {
		host,
		port,
		deviceId,
		options,
		connection: null,
		streamManager: null,

		// session.connection.connected is only ever set false by disconnect() -
		// nothing updates it if the underlying TCP socket dies unexpectedly
		// (device unplugged, network drop), so it can go stale and keep
		// reporting connected. socket.destroyed is live, authoritative state
		// regardless of why the socket went away, so check it directly rather
		// than trusting the flag alone - connect()'s reuse-vs-reconnect
		// decision, and every assertReady() call, depend entirely on this
		// being accurate.
		isConnected: () =>
			Boolean(session.connection && session.connection.connected && session.connection.socket && !session.connection.socket.destroyed),

		// Tears down the current socket only - the leaf stays mounted at
		// api.devices.<key> so it can be reconnected later without needing to
		// re-supply host/port/options. No api-tree work happens here, so
		// unlike remove() this needs no await at all.
		disconnect: () => {
			cancelReconnect();
			if (session.connection) {
				closedByUs.add(session.connection);
				session.connection.disconnect();
			}
		},

		// Lifecycle events: connecting, connected, disconnected ({intentional, hadError}), reconnecting
		// ({attempt, delay, error}), reconnected ({attempt}), error ({error, attempt}) and gave-up
		// ({reason, attempts, error}). Each payload also carries deviceId/host/port. These are plain
		// functions closing over a private EventEmitter (a data property on the leaf would not survive
		// slothlet's mount pipeline). They return the mounted leaf so calls can be chained.
		on: (event, listener) => {
			emitter.on(event, listener);
			return self.devices[deviceKey];
		},
		once: (event, listener) => {
			emitter.once(event, listener);
			return self.devices[deviceKey];
		},
		off: (event, listener) => {
			emitter.off(event, listener);
			return self.devices[deviceKey];
		},

		// (Re)establishes the underlying connection for this SAME leaf - used
		// by connect() (both for the very first connection and for a caller
		// asking to connect a host:port that's already mounted but currently
		// disconnected). A no-op if already connected (mirrors connect()'s own
		// dedupe, rather than forcing a healthy connection to bounce).
		// reconnectOptions overrides only the fields it provides; anything
		// omitted falls back to what this leaf was created (or last
		// reconnected) with.
		reconnect: async (reconnectOptions = {}) => {
			// Always resolve and return self.devices[deviceKey] - the same
			// externally-visible reference every connect()/get() call hands
			// out - rather than the internal `leaf` closure variable itself.
			// The two are NOT interchangeable: see this function's own doc
			// comment above for why a plain-data write is only reliable
			// through the mounted reference, and returning `leaf` directly
			// here would silently hand back a second, divergent "device"
			// object with none of that reference's mirrored state.
			// Merge/remember the new options BEFORE the already-connected
			// short-circuit below - otherwise options passed while already
			// connected would be silently discarded instead of taking effect
			// on the NEXT reconnect, contradicting this function's own "falls
			// back to what this leaf was created (or last reconnected) with"
			// contract.
			leaf.options = { ...leaf.options, ...reconnectOptions };
			if (leaf.isConnected()) return self.devices[deviceKey];
			// An explicit call wins over a pending automatic attempt.
			cancelReconnect();
			await establish();
			return self.devices[deviceKey];
		},

		// The explicit "forget this device" operation - disconnects if still
		// connected, then unmounts the leaf. This is the one genuinely async
		// step in the lifecycle, since it's real api-tree surgery
		// (api.slothlet.api.remove()), unlike disconnect() above.
		remove: async () => {
			leaf.disconnect();
			// Best-effort - an already-removed entry (e.g. a repeated remove()
			// call) would otherwise throw here and mask that the socket was
			// already torn down above.
			await self.slothlet.api.remove(`devices.${deviceKey}`).catch(() => {});
		},

		shell: async (command, shellOptions = {}) => {
			assertReady();
			return await self.shell.execute(session.connection.socket, session.streamManager, command, {
				...shellOptions,
				deviceFeatures: session.connection.deviceFeatures || []
			});
		},

		startStreamingShell: (command, shellOptions = {}) => {
			assertReady();
			return self.shell.startStreaming(session.connection.socket, session.streamManager, command, shellOptions);
		},

		startInteractiveShell: (command, shellOptions = {}) => {
			assertReady();
			return self.shell.startInteractive(session.connection.socket, session.streamManager, command, shellOptions);
		},

		push: async (localPath, remotePath, transferOptions = {}) => {
			assertReady();
			return await self.files.push(session.connection.socket, session.streamManager, localPath, remotePath, transferOptions);
		},

		pull: async (remotePath, localPath, transferOptions = {}) => {
			assertReady();
			return await self.files.pull(session.connection.socket, session.streamManager, remotePath, localPath, transferOptions);
		},

		// SYNC V2 (64-bit) variants - see self.files.pushV2/pullV2 for the
		// wire-level rationale. EXPERIMENTAL, same caveats as push/pull.
		pushV2: async (localPath, remotePath, transferOptions = {}) => {
			assertReady();
			return await self.files.pushV2(session.connection.socket, session.streamManager, localPath, remotePath, transferOptions);
		},

		pullV2: async (remotePath, localPath, transferOptions = {}) => {
			assertReady();
			return await self.files.pullV2(session.connection.socket, session.streamManager, remotePath, localPath, transferOptions);
		},

		list: async (remotePath) => {
			assertReady();
			return await self.files.list(session.connection.socket, session.streamManager, remotePath);
		},

		stat: async (remotePath) => {
			assertReady();
			return await self.files.stat(session.connection.socket, session.streamManager, remotePath);
		},

		listV2: async (remotePath) => {
			assertReady();
			return await self.files.listV2(session.connection.socket, session.streamManager, remotePath);
		},

		statV2: async (remotePath) => {
			assertReady();
			return await self.files.statV2(session.connection.socket, session.streamManager, remotePath);
		},

		// Reboot (real ADB `reboot:` service - see also the shell-based
		// `device.shell("reboot")` fallback, kept for compatibility)
		reboot: async (mode = "") => {
			assertReady();
			return await self.reboot.execute(session.connection.socket, session.streamManager, mode);
		},

		// Port forwarding (adb forward equivalent) - see also self.forward
		forward: async (devicePort, forwardOptions = {}) => {
			assertReady();
			return await self.forward.start(session.connection.socket, session.streamManager, devicePort, forwardOptions);
		},

		// Reverse port forwarding (adb reverse equivalent) - see also self.reverse
		reverse: async (devicePort, hostPort, reverseOptions = {}) => {
			assertReady();
			return await self.reverse.start(session.connection.socket, session.streamManager, devicePort, hostPort, reverseOptions);
		},

		// Local APK install (adb install equivalent). Tries the modern streaming
		// install (self.install.streaming) when the device advertised the "cmd"
		// feature during the CNXN handshake, falling back to the classic
		// push-then-install flow (self.install.classic) otherwise, or if the
		// streaming attempt itself fails partway through (e.g. a device that
		// advertises "cmd" but doesn't actually support `cmd package install`).
		install: async (localPath, installOptions = {}) => {
			assertReady();
			if ((session.connection.deviceFeatures || []).includes("cmd")) {
				try {
					return await self.install.streaming(session.connection.socket, session.streamManager, localPath, installOptions);
				} catch (streamingError) {
					// Fall through to the classic push-then-install flow - but if
					// that ALSO fails, surface the original streaming failure
					// alongside it. Discarding streamingError unconditionally
					// would lose the real cause whenever classic fails too (the
					// caller would only ever see the classic error).
					try {
						return await self.install.classic(session.connection.socket, session.streamManager, localPath, installOptions);
					} catch (classicError) {
						throw new Error(
							`Streaming install failed (${streamingError.message}), and the classic fallback also failed: ${classicError.message}`,
							{ cause: classicError }
						);
					}
				}
			}
			return await self.install.classic(session.connection.socket, session.streamManager, localPath, installOptions);
		},

		// Convenience shell shortcuts
		ls: (path = ".") => leaf.shell(`ls -la ${quoteShellArg(path)}`),
		pwd: () => leaf.shell("pwd"),
		getprop: (prop = null) => leaf.shell(prop ? `getprop ${quoteShellArg(prop)}` : "getprop"),
		getModel: () => leaf.shell("getprop ro.product.model"),
		getAndroidVersion: () => leaf.shell("getprop ro.build.version.release"),
		getBattery: () => leaf.shell("dumpsys battery"),
		screenshot: (filename = "/sdcard/screenshot.png") => leaf.shell(`screencap -p ${quoteShellArg(filename)}`),
		logcat: (logOptions = {}) => leaf.startStreamingShell("logcat", logOptions),
		top: (topOptions = {}) => leaf.startStreamingShell("top -m 10", topOptions),
		keypress: (key) => leaf.shell(`input keyevent ${quoteShellArg(key)}`),
		launchApp: (packageName, activity = "") => {
			// package/activity must reach `am start -n` as a single argument (a
			// single "/"-joined token), so the combined value is quoted as one
			// unit rather than quoting packageName and activity separately.
			const target = activity ? `${packageName}/${activity}` : packageName;
			return leaf.shell(`am start -n ${quoteShellArg(target)}`);
		},
		rebootBootloader: () => leaf.reboot("bootloader"),
		rebootRecovery: () => leaf.reboot("recovery"),
		rebootSideload: () => leaf.reboot("sideload")
	};

	return leaf;
}

/**
 * Connects to an ADB device. Registers the connection as a real leaf at
 * self.devices[key] (see the module doc comment above) and returns that
 * same leaf. Calling this again for a host:port that's already mounted
 * reuses the SAME leaf - reconnecting it in place if it had disconnected,
 * so a caller holding a prior reference (or resolving one later via
 * devices.get()) never has to re-supply host/port/options.
 * @param {string} host - Device host/IP address
 * @param {number} [port=5555] - Device port
 * @param {Object} [options={}] - Connection options
 * @param {string} [options.keyDir] - Directory for RSA keys (default: ~/.adb)
 * @param {boolean|Object} [options.heartbeat=false] - Probe the connection periodically with a trivial shell command and treat a failed or timed-out probe as a dropped connection (see resolveHeartbeatPolicy for the object form).
 * @param {boolean|Object} [options.autoReconnect=false] - Reconnect automatically, with exponential backoff, when the connection drops (see resolveReconnectPolicy for the object form). An explicit disconnect()/remove() never triggers it.
 * @returns {Promise<Object>} The device leaf (also reachable at api.devices.<sanitized host_port>)
 */
export async function connect(host, port = 5555, options = {}) {
	const deviceId = `${host}:${port}`;
	const deviceKey = sanitizeKey(deviceId);

	const existing = self.devices && self.devices[deviceKey];
	if (existing) {
		return await existing.reconnect(options);
	}

	// Mount first, with no connection/stream manager yet - add()'s
	// flatten+wrap pipeline hangs indefinitely when a real net.Socket
	// (deeply nested, self-referential internals) is present anywhere in its
	// input. reconnect() (called immediately below) is the single place that
	// actually opens the session and mirrors it onto the mounted leaf -
	// there's no separate first-connect path to keep in sync with it.
	const leaf = buildDeviceLeaf(host, port, deviceId, deviceKey, options);
	await self.slothlet.api.add(`devices.${deviceKey}`, leaf, { moduleID: `device:${deviceId}` });
	await self.devices[deviceKey].reconnect(options);

	return self.devices[deviceKey];
}

/**
 * Disconnects from a specific device without forgetting it - the leaf stays
 * mounted at api.devices.<key> so a later connect(host, port) reconnects it
 * in place. Synchronous: there's no api-tree work to await here (see
 * remove() for that).
 * @param {string} host - Device host
 * @param {number} [port=5555] - Device port
 * @returns {boolean} True if a device was found and disconnected
 */
export function disconnect(host, port = 5555) {
	const deviceKey = sanitizeKey(`${host}:${port}`);
	const entry = self.devices && self.devices[deviceKey];
	if (!entry) {
		return false;
	}
	entry.disconnect();
	return true;
}

/**
 * Forgets a specific device entirely - disconnects it if still connected,
 * then unmounts its leaf from api.devices. Use disconnect() instead if you
 * only want to tear down the connection while keeping the ability to
 * reconnect later without re-supplying host/port/options.
 * @param {string} host - Device host
 * @param {number} [port=5555] - Device port
 * @returns {Promise<boolean>} True if a device was found and removed
 */
export async function remove(host, port = 5555) {
	const deviceKey = sanitizeKey(`${host}:${port}`);
	const entry = self.devices && self.devices[deviceKey];
	if (!entry) {
		return false;
	}
	await entry.remove();
	return true;
}
