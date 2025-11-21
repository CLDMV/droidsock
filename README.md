# DroidSock

A complete, from-scratch implementation of the Android Debug Bridge (ADB) protocol in Node.js. This library provides full ADB functionality including device connection, RSA authentication, shell command execution, and file transfers - eliminating clicking sounds on Android TV devices!

## Features

- ✅ **Complete ADB Protocol**: Full implementation from TCP connection to high-level APIs
- ✅ **RSA Authentication**: Automatic key generation and ADB-specific formatting
- ✅ **Stream Multiplexing**: Multiple concurrent operations over single connection
- ✅ **Shell Commands**: Execute commands, stream output, interactive sessions
- ✅ **File Transfers**: Push/pull files with SYNC protocol
- ✅ **Device Discovery**: Support for multiple devices via configuration
- ✅ **Error Handling**: Robust error handling and connection recovery

## Installation

```bash
npm install @cldmv/droidsock
```

## Quick Start

```javascript
import DroidSock from "@cldmv/droidsock";

// Create client
const client = new DroidSock({
	host: "10.6.0.108", // Device IP
	port: 5555 // ADB port
});

// Connect
await client.connect();

// Execute shell command
const output = await client.shell("ls -la");
console.log(output);

// Get device info
const model = await client.getModel();
const version = await client.getAndroidVersion();

// File operations
await client.push("./local-file.txt", "/sdcard/remote-file.txt");
await client.pull("/sdcard/remote-file.txt", "./local-file.txt");

// Stream commands
const logcat = client.logcat({
	onData: (data) => console.log(data)
});

// Clean up
client.disconnect();
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

### DroidSock

Main client class for ADB operations.

#### Constructor Options

- `host`: Device IP address
- `port`: ADB port (default: 5555)
- `keyDir`: Directory for RSA keys (default: ~/.adb)

#### Methods

##### Connection

- `connect()`: Connect to device
- `disconnect()`: Disconnect from device
- `isConnected()`: Check connection status

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

- `push(localPath, remotePath, options)`: Push file to device
- `pull(remotePath, localPath, options)`: Pull file from device
- `list(remotePath)`: List directory contents
- `stat(remotePath)`: Get file/directory stats

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

The implementation consists of several layers:

1. **Packet Layer** (`packet.mjs`): Low-level ADB packet creation/parsing
2. **Authentication Layer** (`auth.mjs`): RSA key management and ADB auth
3. **Connection Layer** (`connection.mjs`): TCP connection and auth flow
4. **Stream Layer** (`stream.mjs`): Service multiplexing and data flow
5. **Shell Layer** (`shell.mjs`): Command execution APIs
6. **SYNC Layer** (`sync.mjs`): File transfer protocol
7. **Client Layer** (`adb.mjs`): Unified high-level API

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

MIT License - see package.json for details.

## Contributing

This is a complete implementation of the ADB protocol. For improvements or bug fixes, please submit issues or pull requests.
