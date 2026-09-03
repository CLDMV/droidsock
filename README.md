# DroidSock

<div align="center">
	<img src="https://github.com/CLDMV/droidsock/raw/HEAD/images/droidsock-banner.jpg" alt="DroidSock Banner">
</div>

A complete, from-scratch implementation of the Android Debug Bridge (ADB) protocol in Node.js. This library provides full ADB functionality including device connection, RSA authentication, shell command execution, and file transfers - eliminating clicking sounds on Android TV devices!

[![npm version]][npm_version_url] [![npm downloads]][npm_downloads_url] [![GitHub downloads]][github_downloads_url] [![Last commit]][last_commit_url] [![npm last update]][npm_last_update_url] [![coverage]][coverage_url]

[![Contributors]][contributors_url] [![Sponsor shinrai]][sponsor_url]

> [!NOTE]
> **Current status:**
>
> - **Shell + streaming**: Stable - command execution, interactive shells, and log/process streaming all work over the real ADB protocol.
> - **File transfer**: `mkdir` / `remove` / `move` / `copy` / `chmod` / `diskUsage` / `find` / `stat` work today via shell commands. `list` prefers a binary-safe SYNC-based implementation with automatic shell fallback.
> - **Experimental**: `push` / `pull` / `listSync` (real ADB SYNC sub-protocol usage), `device.reboot()`, `device.forward()` / `device.reverse()`, and `device.install()` are all implemented - built from the ADB protocol spec and covered by mocked unit tests - but **none of them have been run against a real device yet**. See [#1](https://github.com/CLDMV/droidsock/issues/1). Install is push-then-install only - see the [v1.1.0 changelog](./docs/changelog/v1/v1.1.0.md) for what's tracked separately.

---

## ✨ What's New

### Latest: v1.2.0 (September 2026)

- **Device discovery** - `discover.subnet()` sweeps a CIDR range for a reachable ADB TCP port; `discover.mdns()` is a hand-written mDNS client (no dependency) for wireless-debugging-advertised devices. Both **experimental** - see [#1](https://github.com/CLDMV/droidsock/issues/1).
- **Shell-injection fix** - every `files.*` shell-based method now single-quote-escapes remote paths before interpolation; `mkdir`/`chmod`'s mode and `find`'s `maxDepth`/`type` are validated too.
- [View full v1.2.0 Changelog](./docs/changelog/v1/v1.2.0.md)

### Previous: v1.1.0 (September 2026)

- **`list` / `stat` fixed** - v1.0.0 shipped both throwing due to a dangling reference to a module that never existed in the repo.
- **Binary-safe `list()`** - prefers the ADB SYNC `LIST` command, falls back to shell `ls -la` parsing only when SYNC isn't usable.
- **`push` / `pull` implemented (experimental)** - real binary file transfer via the ADB SYNC sub-protocol.
- **`device.reboot()`** (experimental) - the real ADB `reboot:` service, including bootloader/recovery/sideload modes.
- **`device.forward()`** (experimental) - TCP port forwarding (host → device direction).
- **`device.install()`** (experimental) - local APK install via the classic push-then-install flow.
- [View full v1.1.0 Changelog](./docs/changelog/v1/v1.1.0.md)

📚 **For complete version history and detailed release notes, see [docs/changelog/](./docs/changelog/) folder.**

---

## 🚀 Key Features

- ✅ **Complete ADB Protocol**: TCP connection, CNXN/AUTH handshake, and stream multiplexing implemented from scratch
- ✅ **RSA Authentication**: Automatic key generation and ADB-specific signature/public-key formatting
- ✅ **Stream Multiplexing**: Multiple concurrent operations over a single connection
- ✅ **Shell Commands**: Execute commands, stream output, interactive sessions
- ✅ **File Operations**: Shell-based `mkdir` / `remove` / `move` / `copy` / `chmod` / `diskUsage` / `find`, plus binary-safe SYNC-based `list`, and experimental `push` / `pull`
- ✅ **Reboot** (experimental): Real `reboot:` service, including bootloader/recovery/sideload modes
- ✅ **Port Forwarding** (experimental): `adb forward`/`adb reverse`-equivalent TCP tunneling, both directions
- ✅ **APK Install** (experimental): `adb install`-equivalent local APK installation
- ✅ **Device Discovery**: Support for multiple devices via configuration
- ✅ **Error Handling**: Robust error handling and connection recovery

## Installation

```bash
npm install @cldmv/droidsock
```

## Quick Start

```javascript
import droidsock from "@cldmv/droidsock";

// Create the API instance
const api = await droidsock();

// Connect to a device
const device = await api.device.connect("10.6.0.108", 5555);

// Execute a shell command
const output = await device.shell("ls -la");
console.log(output);

// Convenience getters
const model = await device.getModel();
const version = await device.getAndroidVersion();

// Stream commands
const logcat = device.logcat({
	onData: (data) => console.log(data)
});

// Clean up
device.disconnect();
```

## Device Configuration

Use the `references/devices.json` file to configure your devices:

```json
{
	"livingroom": {
		"name": "Living Room TV",
		"host": "10.6.0.108",
		"port": 5555,
		"description": "Main living room Android TV"
	},
	"bedroom": {
		"name": "Master Bedroom TV",
		"host": "10.6.0.118",
		"port": 5555,
		"description": "Master bedroom Android TV"
	},
	"default": "livingroom"
}
```

## API Reference

`droidsock(options)` (also `createDroidSock`) creates the API instance; `api.device.connect(host, port, options)` returns a device object exposing connection state, shell execution/streaming, file operations (`push` / `pull` / `list` / `stat`), reboot, port forwarding, and APK install.

📚 **See [docs/API.md](./docs/API.md) for the full method reference**, including every option and the experimental/scope caveats on `push` / `pull` / `list` / `forward` / `reverse` / `install`.

## Examples

### Basic Usage

```bash
# Run basic example with default device
node examples/basic-usage.mjs

# Run with specific device
node examples/basic-usage.mjs livingroom
```

### Streaming Commands

```bash
# Stream logcat
node examples/streaming-example.mjs logcat

# Stream top command
node examples/streaming-example.mjs top

# File transfer demo
node examples/streaming-example.mjs files
```

## Architecture

`src/droidsock.mjs` composes the layers below into a single api tree via [`@cldmv/slothlet`](https://github.com/CLDMV/slothlet):

1. **Connection Layer** (`src/api/connection.mjs`): TCP socket + CNXN/AUTH handshake
2. **Authentication Layer** (`src/api/auth.mjs`): RSA key management and ADB signature/public-key formatting
3. **Stream Layer** (`src/api/stream.mjs`): ADB stream multiplexing (OPEN/WRTE/OKAY/CLSE)
4. **Shell Layer** (`src/api/shell.mjs`): Command execution, streaming, and interactive shell APIs
5. **Files Layer** (`src/api/files.mjs`): Shell-based file operations, a binary-safe SYNC `LIST` implementation with automatic shell fallback, and an experimental ADB SYNC sub-protocol implementation for real binary transfer (`push` / `pull`) - not yet validated against a real device
6. **Reboot Layer** (`src/api/reboot.mjs`): Real ADB `reboot:` service
7. **Forward Layer** (`src/api/forward.mjs`): TCP port forwarding (host → device) via the `tcp:` service
8. **Reverse Layer** (`src/api/reverse.mjs`): TCP port forwarding (device → host) via `reverse:forward:`/`reverse:killforward:` and the Stream layer's device-initiated stream handling
9. **Install Layer** (`src/api/install.mjs`): Local APK install, composed from the Files and Shell layers
10. **Device Layer** (`src/api/device.mjs`): High-level per-device API composing the layers above
11. **Config / Log Layers** (`src/api/config.mjs`, `src/api/log.mjs`): Shared configuration and logging

📚 **See [docs/PROTOCOL.md](./docs/PROTOCOL.md) for wire-level protocol details** (packet structure, auth flow, SYNC sub-protocol framing, reboot/forward service usage).

## Troubleshooting

### Connection Issues

- Ensure device is on same network
- Enable "ADB over network" in developer options
- Check firewall settings
- Verify IP address and port

### Authentication Issues

- Delete existing keys to force re-authorization: `rm -rf ~/.adb`
- Ensure device shows authorization dialog
- Check device storage permissions

### Common Errors

- "Command timeout": Increase timeout in options
- "Stream not open": Ensure connection is established
- "File not found": Check paths and permissions

## Development

The implementation is built directly from the public ADB protocol documentation (AOSP `SYNC.TXT` and the wire-protocol references), cross-checked against Google's own reference client (`google/python-adb`) where the public docs are ambiguous, and covered by a mocked Vitest suite. The core connection/shell/stream-multiplexing path has real device usage behind it; the newer SYNC-protocol and service additions (`push` / `pull` / `listSync` / `reboot` / `forward` / `install`) have not yet been run against a real device - see the status note at the top of this README and [#1](https://github.com/CLDMV/droidsock/issues/1).

## License

Apache-2.0 - see [LICENSE](LICENSE) for details.

## Contributing

This is a complete implementation of the ADB protocol. For improvements or bug fixes, please submit issues or pull requests.

[npm version]: https://img.shields.io/npm/v/%40cldmv%2Fdroidsock.svg?style=for-the-badge&logo=npm&logoColor=white&labelColor=CB3837
[npm_version_url]: https://www.npmjs.com/package/@cldmv/droidsock
[npm downloads]: https://img.shields.io/npm/dm/%40cldmv%2Fdroidsock.svg?style=for-the-badge&logo=npm&logoColor=white&labelColor=CB3837
[npm_downloads_url]: https://www.npmjs.com/package/@cldmv/droidsock
[github downloads]: https://img.shields.io/github/downloads/CLDMV/droidsock/total?style=for-the-badge&logo=github&logoColor=white&labelColor=181717
[github_downloads_url]: https://github.com/CLDMV/droidsock/releases
[last commit]: https://img.shields.io/github/last-commit/CLDMV/droidsock?style=for-the-badge&logo=github&logoColor=white&labelColor=181717
[last_commit_url]: https://github.com/CLDMV/droidsock/commits
[npm last update]: https://img.shields.io/npm/last-update/%40cldmv%2Fdroidsock?style=for-the-badge&logo=npm&logoColor=white&labelColor=CB3837
[npm_last_update_url]: https://www.npmjs.com/package/@cldmv/droidsock
[coverage]: https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2FCLDMV%2Fdroidsock%2Fbadges%2Fcoverage.json&style=for-the-badge&logo=vitest&logoColor=white
[coverage_url]: https://github.com/CLDMV/droidsock/blob/badges/coverage.json
[contributors]: https://img.shields.io/github/contributors/CLDMV/droidsock.svg?style=for-the-badge&logo=github&logoColor=white&labelColor=181717
[contributors_url]: https://github.com/CLDMV/droidsock/graphs/contributors
[sponsor shinrai]: https://img.shields.io/github/sponsors/shinrai?style=for-the-badge&logo=githubsponsors&logoColor=white&labelColor=EA4AAA&label=Sponsor
[sponsor_url]: https://github.com/sponsors/shinrai
