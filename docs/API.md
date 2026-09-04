# API Reference

## droidsock(options)

The default export, and the quick path - creates a DroidSock API instance. `options.mode` (`"eager"` or `"lazy"`, default `"eager"`), `options.context`, and `options.config` are all optional. Also available under the explicit name `createDroidSock` (`import { createDroidSock } from "@cldmv/droidsock"`) for callers who prefer it - both names are the exact same function.

## devices.connect(host, port, options)

- `host`: Device IP address
- `port`: ADB port (default: `5555`)
- `options.keyDir`: Directory for RSA keys (default: `~/.adb`)

Connects to a device and returns its live leaf. Calling `connect()` again for the same `host:port` returns the existing connection rather than opening a new one. The returned device is also reachable afterward directly off the api tree - not just via the value `connect()` returned - at `api.devices["<sanitized host_port>"]`, where dots and colons in `host:port` are replaced with underscores (e.g. `10.6.0.108:5555` → `api.devices["10_6_0_108_5555"]`). Every connected device lives there for the life of the connection; there is no separate registry to fall out of sync with the live api.

## devices.list() / devices.disconnect(host, port) / devices.disconnectAll()

- `list()`: Returns an array of the currently-connected device leaves.
- `disconnect(host, port)`: Disconnects a specific device (default port `5555`). Returns `true` if a matching device was found, `false` otherwise. **Async** - `await` it.
- `disconnectAll()`: Disconnects every currently-connected device. Returns the number disconnected. **Async** - `await` it.

## The device object (returned by connect())

### Connection

- `isConnected()`: Check connection status
- `disconnect()`: Disconnect from device and remove it from `api.devices`. **Async** - `await` it.

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

Only the `forward` direction (host → device) is implemented; `reverse` (device → host) is tracked separately in [#4](https://github.com/CLDMV/droidsock/issues/4).

### APK Install (Experimental)

- `install(localPath, options)`: **Experimental** - the `adb install <local.apk>` equivalent. Tries the modern streaming install (`exec:cmd package install -S <size>`, no on-device file at all) when the device advertised the `cmd` feature during the CNXN handshake, falling back to the classic push-then-install flow (push the APK to a device temp directory, run `pm install`, remove the temp file regardless of outcome) otherwise, or if the streaming attempt fails partway through. Not yet validated against a real device.
  - `options.flags` (default `[]`): flags passed to `pm install`
  - `options.remoteDir` (default `"/data/local/tmp"`): device directory to push into (classic flow only)
  - `options.onProgress`: forwarded to the underlying `push()` call (classic flow only)

To use one path explicitly instead of the automatic try-streaming-then-fallback behavior, call the underlying module functions directly: `api.install.streaming(device.connection.socket, device.streamManager, localPath, options)` or `api.install.classic(...)` with the same arguments.

---

[← Back to README](../README.md)
