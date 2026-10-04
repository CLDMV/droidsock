# @cldmv/droidsock

<div align="center">
	<img src="https://github.com/CLDMV/droidsock/raw/HEAD/images/droidsock-banner.jpg" alt="DroidSock Banner">
</div>

**DroidSock** is a complete, from-scratch implementation of the Android Debug Bridge (ADB) protocol in Node.js. This library provides full ADB functionality including device connection, RSA authentication, shell command execution, and file transfers - eliminating clicking sounds on Android TV devices!

It talks to devices directly over TCP, with no `adb` binary or ADB server in between, and composes its protocol layers into a single API tree with [`@cldmv/slothlet`](https://github.com/CLDMV/slothlet), so every connected device becomes its own persistent API leaf.

> _ADB over the wire, in pure Node.js - no adb binary required._

[![npm version]][npm_version_url] [![npm downloads]][npm_downloads_url] [![GitHub downloads]][github_downloads_url] [![Last commit]][last_commit_url] [![npm last update]][npm_last_update_url] [![coverage]][coverage_url]

> [!NOTE]
> **Current status:**
>
> - **Shell + streaming**: Stable - command execution, interactive shells, and log/process streaming all work over the real ADB protocol.
> - **File transfer**: `mkdir` / `remove` / `move` / `copy` / `chmod` / `diskUsage` / `find` / `stat` work today via shell commands. `list` prefers a binary-safe SYNC-based implementation with automatic shell fallback.
> - **Experimental**: `push` / `pull` / `pushV2` / `pullV2` / `listSync` / `listV2` / `statV2` (real ADB SYNC sub-protocol usage, both the legacy 32-bit and newer 64-bit variants), `device.reboot()`, `device.forward()` / `device.reverse()`, `device.install()` (both the classic push-then-install and modern streaming install paths), and `pairing.pair()` (Wi-Fi pairing) are all implemented - built from the ADB protocol spec and covered by unit tests (several exercised against real loopback TCP/TLS servers, not purely mocks) - but **none of them have been run against a real device yet**. See [#1](https://github.com/CLDMV/droidsock/issues/1).

[![Contributors]][contributors_url] [![Sponsor shinrai]][sponsor_url]

---

## ✨ What's New

### Latest: v2.0.3 (October 2026)

- **Bundler-friendly CommonJS entry** - `index.cjs` now loads the ESM entry with a plain `require()` instead of `createRequire`, so esbuild and webpack can follow it, and on a Node.js version without `require(esm)` it fails with a clear message pointing to `import()`. The ESM entry and the API are unchanged ([#58](https://github.com/CLDMV/droidsock/pull/58)).
- **`devcheck` no longer published** - the source-checkout-only `devcheck.mjs` and its `./devcheck` subpath export are gone from the package. It never did anything in an installed copy, but importing `@cldmv/droidsock/devcheck` now throws `ERR_PACKAGE_PATH_NOT_EXPORTED`, so remove any such import ([#58](https://github.com/CLDMV/droidsock/pull/58)).
- [View full v2.0.3 Changelog](https://github.com/CLDMV/droidsock/blob/master/docs/changelog/v2/v2.0.3.md)

### Recent Releases

- **v2.0.2** (October 2026) - Dev tooling only: shared CLDMV fix-headers config and a required PR check that never reports as skipped, no runtime change ([Changelog](https://github.com/CLDMV/droidsock/blob/master/docs/changelog/v2/v2.0.2.md))
- **v2.0.1** (October 2026) - No runtime change, but `engines.node` rose to `>=22.12.0` (from `>=20.19.0`) to match the vitest 5 toolchain; also syncs the v4 workflows with the v4.29.2 templates ([Changelog](https://github.com/CLDMV/droidsock/blob/master/docs/changelog/v2/v2.0.1.md))
- **v2.0.0** (September 2026) - Breaking: the `device` module splits into `device` and `devices`, device leaves persist across a disconnect, plus IPv6, `devices.get()`, and experimental `device.reverse()`, Wi-Fi pairing, streaming install and SYNC V2 ([Changelog](https://github.com/CLDMV/droidsock/blob/master/docs/changelog/v2/v2.0.0.md))
- **v1.2.0** (September 2026) - Device discovery (`discover.subnet()` CIDR sweep, `discover.mdns()` for wireless-debugging-advertised devices, both experimental) and a shell-injection fix across every `files.*` shell-based method ([Changelog](https://github.com/CLDMV/droidsock/blob/master/docs/changelog/v1/v1.2.0.md))

📚 **For complete version history and detailed release notes, see the [docs/changelog/](https://github.com/CLDMV/droidsock/tree/master/docs/changelog/) folder.**

---

## 🚀 Key Features

- ✅ **Complete ADB Protocol**: TCP connection, CNXN/AUTH handshake, and stream multiplexing implemented from scratch
- ✅ **RSA Authentication**: Automatic key generation and ADB-specific signature/public-key formatting
- ✅ **Stream Multiplexing**: Multiple concurrent operations over a single connection
- ✅ **Shell Commands**: Execute commands, stream output, interactive sessions
- ✅ **File Operations**: Shell-based `mkdir` / `remove` / `move` / `copy` / `chmod` / `diskUsage` / `find`, plus binary-safe SYNC-based `list`, and experimental `push` / `pull` (legacy 32-bit) / `pushV2` / `pullV2` / `listV2` / `statV2` (64-bit)
- ✅ **Reboot** (experimental): Real `reboot:` service, including bootloader/recovery/sideload modes
- ✅ **Port Forwarding** (experimental): `adb forward`/`adb reverse`-equivalent TCP tunneling, both directions
- ✅ **APK Install** (experimental): `adb install`-equivalent local APK installation - classic push-then-install and modern streaming (`exec:cmd package install`) paths
- ✅ **Wi-Fi Pairing** (experimental): `adb pair`-equivalent PIN-based pairing (SPAKE2-over-Ed25519 + TLS 1.3) for Android 11+ wireless debugging
- ✅ **Device Discovery** (experimental): `discover.subnet()` CIDR sweep and `discover.mdns()` for devices advertising wireless debugging, plus support for multiple devices via configuration
- ✅ **Error Handling**: Robust error handling and connection recovery

---

## 📦 Installation

### Requirements

- **Node.js v22.12.0 or higher** (the package's `engines.node` floor)
- Both `import` and `require()` are supported. `require()` loads the ESM entry through Node's synchronous `require(esm)`, which needs Node.js ^20.19.0 or >=22.12.0; on older versions, load the package with `import()` instead.

### Install

```bash
npm install @cldmv/droidsock
```

---

## 🚀 Quick Start

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
await device.disconnect();
```

CommonJS works the same way: `const droidsock = require("@cldmv/droidsock")` (also available as `createDroidSock`).

---

## ⚙️ Device Configuration

The example scripts read device addresses from `references/devices.json`. The folder is git-ignored, so create the file yourself:

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

---

## 📘 API Reference

`droidsock(options)` (also `createDroidSock`) creates the API instance; `api.device.connect(host, port, options)` connects to a device (IPv4 or IPv6) and returns its live leaf - also reachable afterward at `api.devices["<host>_<port>"]` (a `.` becomes `_`, a `:` becomes `__`) - exposing connection state, shell execution/streaming, file operations (`push` / `pull` / `list` / `stat`), reboot, port forwarding, and APK install. `api.device.disconnect(host, port)` tears down one device's connection without forgetting it - reconnect later with `connect()` on the same host:port, no need to re-supply options; `api.device.remove(host, port)` forgets it entirely. `api.devices.list()` / `disconnect()` (all) / `remove()` (all) / `get(idOrLeaf)` manage the set of known devices as a whole.

📚 **See [docs/API.md](https://github.com/CLDMV/droidsock/blob/master/docs/API.md) for the full method reference**, including every option and the experimental/scope caveats on `push` / `pull` / `list` / `forward` / `reverse` / `install`.

---

## 💡 Examples

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

---

## 🏗️ Architecture

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
10. **Pairing Layer** (`src/api/pairing.mjs`): Wi-Fi pairing (`adb pair` equivalent) - a separate TLS 1.3 + SPAKE2 protocol reusing the Authentication layer's persistent RSA identity, not composed with any of the layers above
11. **Device / Devices Layers** (`src/api/device.mjs`, `src/api/devices.mjs`): High-level per-device API composing the layers above, split by single-target (`device.connect`/`disconnect`/`remove`) vs. collection-wide (`devices.list`/`disconnect`/`remove`/`get`) operations. Each device is a real, persistent slothlet leaf at `api.devices.<sanitized host_port>`, assigned there by `connect()` rather than held in a private module variable, so its methods keep working `self`/context access exactly like any other leaf - the leaf outlives any one connection, and only `remove()` unmounts it
12. **Config / Log Layers** (`src/api/config.mjs`, `src/api/log.mjs`): Shared configuration and logging

📚 **See [docs/PROTOCOL.md](https://github.com/CLDMV/droidsock/blob/master/docs/PROTOCOL.md) for wire-level protocol details** (packet structure, auth flow, SYNC sub-protocol framing, reboot/forward service usage).

---

## 🛠 Troubleshooting

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

---

## 🧪 Development

The implementation is built directly from the public ADB protocol documentation (AOSP `SYNC.TXT` and the wire-protocol references), cross-checked against Google's own reference client (`google/python-adb`) where the public docs are ambiguous, and covered by a mocked Vitest suite. The core connection/shell/stream-multiplexing path has real device usage behind it; the newer SYNC-protocol and service additions (`push` / `pull` / `listSync` / `reboot` / `forward` / `install`) have not yet been run against a real device - see the status note at the top of this README and [#1](https://github.com/CLDMV/droidsock/issues/1).

---

## 📚 Documentation

- **[API Reference](https://github.com/CLDMV/droidsock/blob/master/docs/API.md)** - every method and option, with the experimental and scope caveats
- **[Protocol Details](https://github.com/CLDMV/droidsock/blob/master/docs/PROTOCOL.md)** - packet structure, auth flow, SYNC sub-protocol framing, reboot / forward service usage
- **[Changelog](https://github.com/CLDMV/droidsock/tree/master/docs/changelog/)** - per-version release notes

[![CodeFactor]][codefactor_url] [![OpenSSF Scorecard]][ossf_scorecard_url] [![npms.io score]][npms_url] [![npm unpacked size]][npm_size_url] [![Repo size]][repo_size_url]

---

## 🤝 Contributing

This is a complete implementation of the ADB protocol. For improvements or bug fixes, please submit issues or pull requests.

[![Contributors]][contributors_url] [![Sponsor shinrai]][sponsor_url]

---

## 🔗 Links

- **npm**: [@cldmv/droidsock](https://www.npmjs.com/package/@cldmv/droidsock)
- **GitHub**: [CLDMV/droidsock](https://github.com/CLDMV/droidsock)
- **Issues**: [GitHub Issues](https://github.com/CLDMV/droidsock/issues)
- **Changelog**: [docs/changelog/](https://github.com/CLDMV/droidsock/tree/master/docs/changelog/)

---

## 📄 License

[![GitHub license]][github_license_url] [![npm license]][npm_license_url]

Apache-2.0 - see [LICENSE](https://github.com/CLDMV/droidsock/blob/HEAD/LICENSE) for details.

[npm version]: https://img.shields.io/npm/v/%40cldmv%2Fdroidsock.svg?style=for-the-badge&logo=npm&logoColor=white&labelColor=CB3837
[npm_version_url]: https://www.npmjs.com/package/@cldmv/droidsock
[last commit]: https://img.shields.io/github/last-commit/CLDMV/droidsock?style=for-the-badge&logo=github&logoColor=white&labelColor=181717
[last_commit_url]: https://github.com/CLDMV/droidsock/commits
[npm last update]: https://img.shields.io/npm/last-update/%40cldmv%2Fdroidsock?style=for-the-badge&logo=npm&logoColor=white&labelColor=CB3837
[npm_last_update_url]: https://www.npmjs.com/package/@cldmv/droidsock
[codefactor]: https://img.shields.io/codefactor/grade/github/CLDMV/droidsock?style=for-the-badge&logo=codefactor&logoColor=white&labelColor=F44A6A
[codefactor_url]: https://www.codefactor.io/repository/github/cldmv/droidsock
[openssf scorecard]: https://img.shields.io/ossf-scorecard/github.com/CLDMV/droidsock?style=for-the-badge&label=OpenSSF%20Scorecard
[ossf_scorecard_url]: https://scorecard.dev/viewer/?uri=github.com/CLDMV/droidsock
[npms.io score]: https://img.shields.io/npms-io/final-score/%40cldmv%2Fdroidsock?style=for-the-badge&logo=npms&logoColor=white&labelColor=0B5D57
[npms_url]: https://npms.io/search?q=%40cldmv%2Fdroidsock
[npm downloads]: https://img.shields.io/npm/dm/%40cldmv%2Fdroidsock.svg?style=for-the-badge&logo=npm&logoColor=white&labelColor=CB3837
[npm_downloads_url]: https://www.npmjs.com/package/@cldmv/droidsock
[github downloads]: https://img.shields.io/github/downloads/CLDMV/droidsock/total?style=for-the-badge&logo=github&logoColor=white&labelColor=181717
[github_downloads_url]: https://github.com/CLDMV/droidsock/releases
[npm unpacked size]: https://img.shields.io/npm/unpacked-size/%40cldmv%2Fdroidsock.svg?style=for-the-badge&logo=npm&logoColor=white&labelColor=CB3837
[npm_size_url]: https://www.npmjs.com/package/@cldmv/droidsock
[repo size]: https://img.shields.io/github/repo-size/CLDMV/droidsock?style=for-the-badge&logo=github&logoColor=white&labelColor=181717
[repo_size_url]: https://github.com/CLDMV/droidsock
[github license]: https://img.shields.io/github/license/CLDMV/droidsock.svg?style=for-the-badge&logo=github&logoColor=white&labelColor=181717
[github_license_url]: https://github.com/CLDMV/droidsock/blob/HEAD/LICENSE
[npm license]: https://img.shields.io/npm/l/%40cldmv%2Fdroidsock.svg?style=for-the-badge&logo=npm&logoColor=white&labelColor=CB3837
[npm_license_url]: https://www.npmjs.com/package/@cldmv/droidsock
[coverage]: https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2FCLDMV%2Fdroidsock%2Fbadges%2Fcoverage.json&style=for-the-badge&logo=vitest&logoColor=white
[coverage_url]: https://github.com/CLDMV/droidsock/blob/badges/coverage.json
[contributors]: https://img.shields.io/github/contributors/CLDMV/droidsock.svg?style=for-the-badge&logo=github&logoColor=white&labelColor=181717
[contributors_url]: https://github.com/CLDMV/droidsock/graphs/contributors
[sponsor shinrai]: https://img.shields.io/github/sponsors/shinrai?style=for-the-badge&logo=githubsponsors&logoColor=white&labelColor=EA4AAA&label=Sponsor
[sponsor_url]: https://github.com/sponsors/shinrai
