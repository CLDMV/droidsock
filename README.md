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
> - **File transfer**: `mkdir`/`remove`/`move`/`copy`/`chmod`/`diskUsage`/`find` work today via shell commands. `push`/`pull`/`list`/`stat` (the SYNC sub-protocol) are not implemented yet.

---

## ✨ What's New

### Latest: v1.0.0 (September 2026)

- **First stable release** - a real Vitest test suite with measured coverage, the full CLDMV v4 CI/release pipeline, a real `dist/` build, and an API surface that's been reviewed rather than just grown.
- **Breaking**: the default export is now itself the callable quick path (`await droidsock()`); the old top-level `connect()`/`listDevices()` exports are gone.
- [View full v1.0.0 Changelog](./docs/changelog/v1/v1.0.0.md)

📚 **For complete version history and detailed release notes, see [docs/changelog/](./docs/changelog/) folder.**

---

## 🚀 Key Features

- ✅ **Complete ADB Protocol**: TCP connection, CNXN/AUTH handshake, and stream multiplexing implemented from scratch
- ✅ **RSA Authentication**: Automatic key generation and ADB-specific signature/public-key formatting
- ✅ **Stream Multiplexing**: Multiple concurrent operations over a single connection
- ✅ **Shell Commands**: Execute commands, stream output, interactive sessions
- ✅ **Shell-Based File Operations**: `mkdir`, `remove`, `move`, `copy`, `chmod`, `diskUsage`, `find`
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

### droidsock(options)

The default export, and the quick path - creates a DroidSock API instance. `options.mode` (`"eager"` or `"lazy"`, default `"eager"`), `options.context`, and `options.config` are all optional. Also available under the explicit name `createDroidSock` (`import { createDroidSock } from "@cldmv/droidsock"`) for callers who prefer it - both names are the exact same function.

#### device.connect(host, port, options)

- `host`: Device IP address
- `port`: ADB port (default: 5555)
- `options.keyDir`: Directory for RSA keys (default: `~/.adb`)

Returns a device object with the methods below.

##### Connection

- `isConnected()`: Check connection status
- `disconnect()`: Disconnect from device

##### Shell Commands

- `shell(command, options)`: Execute shell command
- `startStreamingShell(command, options)`: Start streaming command
- `startInteractiveShell(command, options)`: Start interactive command

##### Convenience Methods

- `ls(path)`: List directory
- `pwd()`: Get current directory
- `getprop(property)`: Get system property
- `getModel()`: Get device model
- `getAndroidVersion()`: Get Android version
- `getBattery()`: Get battery status
- `screenshot(filename)`: Take screenshot
- `logcat(options)`: Stream logcat
- `top(options)`: Stream top command

##### File Operations

- `push(localPath, remotePath, options)`: **Not yet implemented** - throws
- `pull(remotePath, localPath, options)`: **Not yet implemented** - throws

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
5. **Files Layer** (`src/api/files.mjs`): Shell-based file operations (SYNC-protocol `push`/`pull`/`list`/`stat` not yet implemented)
6. **Device Layer** (`src/api/device.mjs`): High-level per-device API composing the layers above
7. **Config / Log Layers** (`src/api/config.mjs`, `src/api/log.mjs`): Shared configuration and logging

## Protocol Implementation Details

### Packet Structure

All ADB packets follow a 24-byte header + optional data format:

- Command (4 bytes, little-endian)
- Arg0/Arg1 (4 bytes each, little-endian)
- Data length (4 bytes, little-endian)
- Checksum (4 bytes, sum of data bytes)
- Magic (4 bytes, command XOR 0xFFFFFFFF)

### Authentication Flow

1. Client sends CNXN packet
2. Server responds with AUTH(TOKEN)
3. Client signs token with RSA private key
4. Client sends AUTH(SIGNATURE)
5. If rejected, client sends AUTH(RSAPUBLICKEY)
6. Server prompts user to authorize
7. Server sends CNXN on successful auth

### Stream Multiplexing

- Each service (shell, sync, etc.) gets unique local/remote ID pair
- WRTE packets carry data, OKAY packets acknowledge receipt
- CLSE packets close streams
- Multiple streams operate concurrently

### File Transfer (SYNC)

- Uses "sync:" service with sub-protocol
- SEND/RECV commands for push/pull
- DATA packets for file chunks
- DONE packets signal completion
- Not yet implemented - see [Current status](#-key-features) above

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

The implementation is based on:

- Working ADB client implementation analysis
- Kotlin reference implementation
- Extensive testing with real Android devices
- ADB protocol documentation

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
