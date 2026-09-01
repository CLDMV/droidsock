# API Reference

## droidsock(options)

The default export, and the quick path - creates a DroidSock API instance. `options.mode` (`"eager"` or `"lazy"`, default `"eager"`), `options.context`, and `options.config` are all optional. Also available under the explicit name `createDroidSock` (`import { createDroidSock } from "@cldmv/droidsock"`) for callers who prefer it - both names are the exact same function.

## device.connect(host, port, options)

- `host`: Device IP address
- `port`: ADB port (default: `5555`)
- `options.keyDir`: Directory for RSA keys (default: `~/.adb`)

Returns a device object with the methods below. Calling `connect()` again for the same `host:port` returns the existing connection rather than opening a new one.

### Connection

- `isConnected()`: Check connection status
- `disconnect()`: Disconnect from device

### Shell Commands

- `shell(command, options)`: Execute a shell command and return its output
- `startStreamingShell(command, options)`: Start a streaming command (`options.onData`/`onError`/`onEnd`); returns a control object with `stop()`
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

- `push(localPath, remotePath, options)`: **Experimental** - real binary transfer via the ADB SYNC sub-protocol. `options.onProgress`, `options.mode` (default `0o644`). Not yet validated against a real device.
- `pull(remotePath, localPath, options)`: **Experimental** - real binary transfer via the ADB SYNC sub-protocol. `options.onProgress`. Not yet validated against a real device.
- `list(remotePath)`: List directory contents, preferring the binary-safe SYNC `LIST` command (**experimental**, not yet validated against a real device) and falling back to shell `ls -la` parsing when the SYNC service isn't usable. A real `LIST` failure (e.g. a missing path) is never masked by the fallback - it's rethrown as-is.
- `stat(remotePath)`: Get file/directory info via shell (raw `stat` output)

For direct access to one specific listing implementation (bypassing the automatic SYNC-then-shell preference), call the underlying module functions directly: `api.files.listSync(device.connection.socket, device.streamManager, remotePath)` or `api.files.listShell(...)` with the same arguments.

### Reboot (Experimental)

- `reboot(mode)`: **Experimental** - reboots the device via the real ADB `reboot:` service - a distinct top-level service like `shell:`/`sync:`, not a shell command. `mode` is `""` (normal, default), `"bootloader"`, `"recovery"`, `"sideload"`, `"sideload-auto-reboot"`, or any other string for a vendor-specific target. Not yet validated against a real device.
- `rebootBootloader()` / `rebootRecovery()` / `rebootSideload()`: Shortcuts for the corresponding `reboot(mode)` call.

`device.shell("reboot")` still works unchanged for a plain reboot - it's just unable to reach bootloader/recovery/sideload, since those aren't real shell commands.

### Port Forwarding (Experimental)

- `forward(devicePort, options)`: **Experimental** - the `adb forward tcp:<localPort> tcp:<devicePort>` equivalent. Listens on a local TCP port and bridges each accepted connection to a new ADB stream on the device's `tcp:<devicePort>` service. Returns `{ localPort, close() }`. Not yet validated against a real device.
  - `options.localPort` (default `0`, letting the OS pick a free port)
  - `options.host` (default `"127.0.0.1"`)
  - `options.onError(error, localSocket)`: called on a per-connection bridging error

Only the `forward` direction (host → device) is implemented; `reverse` (device → host) is tracked separately in [#4](https://github.com/CLDMV/droidsock/issues/4).

### APK Install (Experimental)

- `install(localPath, options)`: **Experimental** - the `adb install <local.apk>` equivalent. Pushes the local APK to a device temp directory, runs `pm install`, then removes the temp file regardless of outcome. Depends on the experimental `push()`, so it's unvalidated against a real device too even though it adds no new protocol work of its own.
  - `options.flags` (default `[]`): flags passed to `pm install`, e.g. `["-r"]` to reinstall
  - `options.remoteDir` (default `"/data/local/tmp"`): device directory to push into
  - `options.onProgress`: forwarded to the underlying `push()` call

Only the classic push-then-install flow is implemented; the modern streaming install path (`exec:cmd package install`, no on-device file at all) is tracked separately in [#7](https://github.com/CLDMV/droidsock/issues/7).

---

[← Back to README](../README.md)
