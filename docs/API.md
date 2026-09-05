# API Reference

## droidsock(options)

The default export, and the quick path - creates a DroidSock API instance. `options.mode` (`"eager"` or `"lazy"`, default `"eager"`), `options.context`, and `options.config` are all optional. Also available under the explicit name `createDroidSock` (`import { createDroidSock } from "@cldmv/droidsock"`) for callers who prefer it - both names are the exact same function.

## device.connect(host, port, options) / device.disconnect(host, port) / device.remove(host, port)

Single-target operations - the module name (singular `device`) disambiguates them from the collection-wide operations on `devices` below. A device leaf, once created, is a persistent handle that outlives any one TCP connection: `disconnect()` only tears down the current socket, it does **not** forget the device - `connect()` on the same `host:port` later reconnects that exact same leaf, reusing whatever `options` it was created with, so a reference you're holding stays valid and you never have to re-supply `host`/`port`/`options` just to reconnect. `remove()` is the separate, explicit "forget this device" operation.

- `connect(host, port, options)`:
  - `host`: Device IP address (IPv4 or IPv6)
  - `port`: ADB port (default: `5555`)
  - `options.keyDir`: Directory for RSA keys (default: `~/.adb`)

  Connects to a device and returns its live leaf. Calling `connect()` again for the same `host:port` reuses the same leaf - if it's already connected, that connection is returned as-is; if it had disconnected, it's reconnected in place. An `options` argument passed on a later call only overrides the fields it provides (e.g. a different `keyDir`); anything omitted falls back to what the device was created with. The device is also reachable afterward directly off the api tree - not just via the value `connect()` returned - at `api.devices["<sanitized host_port>"]`, where a `.` in `host:port` becomes a single `_` and a `:` becomes a double `__` (the two would otherwise collide into indistinguishable runs of underscores for an IPv6 host), e.g. `10.6.0.108:5555` → `api.devices["10_6_0_108__5555"]`. Every device that's ever been connected lives there until explicitly `remove()`d.

- `disconnect(host, port)`: Tears down a specific device's connection without forgetting it (default port `5555`) - its leaf stays mounted and reconnectable. Returns `true` if a matching device was found, `false` otherwise. Synchronous.

- `remove(host, port)`: Disconnects (if needed) and unmounts a specific device's leaf entirely - the actual "forget this device" operation. Returns `true` if a matching device was found, `false` otherwise. **Async** - `await` it.

## devices.list() / devices.disconnect() / devices.remove() / devices.get(idOrLeaf)

Collection-wide operations, mounted alongside every device's own leaf at `api.devices.<sanitized host_port>`.

- `list()`: Returns an array of the currently-connected device leaves. A known-but-disconnected device is not included.
- `disconnect()`: Takes **no arguments** - disconnects every known device (connected or not; a no-op for one that's already disconnected), keeping every leaf mounted for later reconnection. Returns the number disconnected. Synchronous. Throws if called with any argument, catching a mix-up with the single-target `device.disconnect(host, port)`.
- `remove()`: Takes **no arguments** - disconnects and unmounts every known device leaf. Returns the number removed. **Async** - `await` it. Throws if called with any argument, catching a mix-up with the single-target `device.remove(host, port)`.
- `get(idOrLeaf)`: Looks up a device leaf - connected or currently disconnected - by `"host:port"` string (bracket an IPv6 host with a port, e.g. `"[2001:db8::1]:5555"`) or by the leaf object itself (as returned by `connect()`). Returns `undefined` only for a device that was never connected or has since been `remove()`d.

## The device object (returned by connect())

### Connection

- `isConnected()`: Check connection status - always reflects the live socket state.
- `disconnect()`: Disconnect without forgetting this device - its leaf stays mounted at `api.devices` and can be reconnected later via `device.connect(host, port)`. Synchronous.
- `reconnect(options)`: Re-establishes the connection for this same leaf; a no-op if already connected. `options` overrides only the fields it provides, falling back to whatever this device was created (or last reconnected) with. **Async** - `await` it. (`device.connect(host, port, options)` calls this automatically when the target is already known but disconnected - most callers won't need to call it directly.)
- `remove()`: Disconnects (if needed) and unmounts this device's leaf from `api.devices` - the same operation as `device.remove(host, port)`, called on the leaf directly. **Async** - `await` it.

### Shell Commands

- `shell(command, options)`: Execute a shell command and return its output
- `startStreamingShell(command, options)`: Start a streaming command (`options.onData` / `onError` / `onEnd`); returns a control object with `stop()`
- `startInteractiveShell(command, options)`: Start an interactive command; returns a control object with `sendInput(data)` and `stop()`

### Convenience Methods

- `ls(path)`: List directory via shell (`ls -la`)
- `pwd()`: Get current directory
- `getprop(property)`: Get a system property (all properties if omitted)
- `getModel()`: Get device model
- `getAndroidVersion()`: Get Android version
- `getBattery()`: Get battery status (`dumpsys battery`)
- `screenshot(filename)`: Take a screenshot (`screencap -p`)
- `logcat(options)`: Stream logcat - same streaming control object as `startStreamingShell`
- `top(options)`: Stream `top -m 10`
- `keypress(key)`: Send a keyevent (`input keyevent`)
- `launchApp(packageName, activity)`: Launch an app (`am start`)

### File Operations

- `push(localPath, remotePath, options)`: **Experimental** - real binary transfer via the ADB SYNC sub-protocol (legacy 32-bit `SEND`). `options.onProgress`, `options.mode` (default `0o644`). Not yet validated against a real device.
- `pull(remotePath, localPath, options)`: **Experimental** - real binary transfer via the ADB SYNC sub-protocol (legacy 32-bit `RECV`). `options.onProgress`. Not yet validated against a real device.
- `pushV2(localPath, remotePath, options)` / `pullV2(remotePath, localPath, options)`: **Experimental** - the 64-bit `SEND_V2`/`RECV_V2` SYNC variants, for files/listings beyond the legacy 32-bit ~2.14GB ceiling. Same options as `push`/`pull`, plus `options.compression` (`"none"` (default) or `"brotli"`) for per-chunk compression - only usable against a device that also advertised `sendrecv_v2_brotli`. `lz4`/`zstd` aren't implemented (tracked separately). Only usable against a device that advertised the `sendrecv_v2` feature. See [#8](https://github.com/CLDMV/droidsock/issues/8).
- `list(remotePath)`: List directory contents, preferring the binary-safe SYNC `LIST` command (**experimental**, not yet validated against a real device) and falling back to shell `ls -la` parsing when the SYNC service isn't usable. A real `LIST` failure (e.g. a missing path) is never masked by the fallback - it's rethrown as-is.
- `listV2(remotePath)`: **Experimental** - the 64-bit `LIST_V2` SYNC variant. No shell fallback. Only usable against a device that advertised the `ls_v2` feature.
- `stat(remotePath)`: Get file/directory info via shell (raw `stat` output)
- `statV2(remotePath)`: **Experimental** - binary-safe stat via the 64-bit `STAT_V2` SYNC command, returning structured fields (`mode`/`size`/`atime`/`mtime`/`ctime`/`uid`/`gid`/`nlink`/`dev`/`ino` - the 64-bit fields as `BigInt`) instead of raw shell text. Only usable against a device that advertised the `stat_v2` feature.

For direct access to one specific listing implementation (bypassing the automatic SYNC-then-shell preference), call the underlying module functions directly: `api.files.listSync(device.connection.socket, device.streamManager, remotePath)` or `api.files.listShell(...)` with the same arguments.

### Reboot (Experimental)

- `reboot(mode)`: **Experimental** - reboots the device via the real ADB `reboot:` service - a distinct top-level service like `shell:` / `sync:`, not a shell command. `mode` is `""` (normal, default), `"bootloader"`, `"recovery"`, `"sideload"`, `"sideload-auto-reboot"`, or any other string for a vendor-specific target. Not yet validated against a real device.
- `rebootBootloader()` / `rebootRecovery()` / `rebootSideload()`: Shortcuts for the corresponding `reboot(mode)` call.

`device.shell("reboot")` still works unchanged for a plain reboot - it's just unable to reach bootloader/recovery/sideload, since those aren't real shell commands.

### Port Forwarding (Experimental)

- `forward(devicePort, options)`: **Experimental** - the `adb forward tcp:<localPort> tcp:<devicePort>` equivalent. Listens on a local TCP port and bridges each accepted connection to a new ADB stream on the device's `tcp:<devicePort>` service. Returns `{ localPort, close() }`. Not yet validated against a real device.
  - `options.localPort` (default `0`, letting the OS pick a free port)
  - `options.host` (default `"127.0.0.1"`)
  - `options.onError(error, localSocket)`: called on a per-connection bridging error
- `reverse(devicePort, hostPort, options)`: **Experimental** - the `adb reverse tcp:<devicePort> tcp:<hostPort>` equivalent. Registers the tunnel with the device (`reverse:forward:tcp:<devicePort>;tcp:<hostPort>`), then bridges each device-initiated connection to a new local TCP connection on `hostPort`. Returns `{ devicePort, hostPort, close() }` - `close()` also unregisters the tunnel via `reverse:killforward:`. Not yet validated against a real device.
  - `options.host` (default `"127.0.0.1"`)
  - `options.onError(error, deviceStream)`: called on a per-connection bridging error

### APK Install (Experimental)

- `install(localPath, options)`: **Experimental** - the `adb install <local.apk>` equivalent. Tries the modern streaming install (`exec:cmd package install -S <size>`, no on-device file at all) when the device advertised the `cmd` feature during the CNXN handshake, falling back to the classic push-then-install flow (push the APK to a device temp directory, run `pm install`, remove the temp file regardless of outcome) otherwise, or if the streaming attempt fails partway through. Not yet validated against a real device.
  - `options.flags` (default `[]`): flags passed to `pm install`
  - `options.remoteDir` (default `"/data/local/tmp"`): device directory to push into (classic flow only)
  - `options.onProgress`: forwarded to the underlying `push()` call (classic flow only)

To use one path explicitly instead of the automatic try-streaming-then-fallback behavior, call the underlying module functions directly: `api.install.streaming(device.connection.socket, device.streamManager, localPath, options)` or `api.install.classic(...)` with the same arguments.

---

[← Back to README](../README.md)
