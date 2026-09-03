# Protocol Implementation Details

## Packet Structure

All ADB packets follow a 24-byte header + optional data format:

- Command (4 bytes, little-endian)
- Arg0/Arg1 (4 bytes each, little-endian)
- Data length (4 bytes, little-endian)
- Checksum (4 bytes, sum of data bytes)
- Magic (4 bytes, command XOR `0xFFFFFFFF`)

## Authentication Flow

1. Client sends CNXN packet
2. Server responds with AUTH(TOKEN)
3. Client signs token with RSA private key
4. Client sends AUTH(SIGNATURE)
5. If rejected, client sends AUTH(RSAPUBLICKEY)
6. Server prompts user to authorize
7. Server sends CNXN on successful auth

## Stream Multiplexing

- Each service (`shell:`, `sync:`, `reboot:`, `tcp:<port>`, etc.) gets its own local/remote ID pair
- WRTE packets carry data, OKAY packets acknowledge receipt
- CLSE packets close streams
- Multiple streams operate concurrently over the single underlying TCP connection

## File Transfer (SYNC)

Uses the `"sync:"` service, which carries its own sub-protocol nested inside the stream. Every SYNC frame is an 8-byte header - a 4-byte ASCII id followed by a 4-byte little-endian value - optionally followed by `value` bytes of payload. The one asymmetric special case: the `DONE` frame the client sends to terminate a `push` repurposes that 4-byte value field to carry the desired mtime (seconds since epoch) instead of a payload length, and sends no payload bytes at all.

- **`SEND` / `RECV`** (`push` / `pull`): `DATA` packets carry file chunks (chunked at the protocol's 64KB ceiling); `DONE` signals completion; `FAIL` carries a UTF-8 error message. Implemented from the public protocol spec (AOSP `SYNC.TXT`), cross-checked against Google's own reference client (`google/python-adb`'s `filesync_protocol.py`) - **experimental**, not yet validated against a real device. See [#1](https://github.com/CLDMV/droidsock/issues/1).
- **`LIST`** (binary-safe directory listing): the request follows the generic frame shape (id + path length + path). Responses are a different shape - `DENT` entries pack four 4-byte fields (mode, size, mtime, namelen) before the variable-length name, not the generic id+value+payload layout - followed by a `DONE` (generic shape) once the listing is complete, or a `FAIL` on error. If the stream closes or errors before a `DONE` / `FAIL` arrives (a real disconnect or protocol error), the frame reader rejects rather than waiting forever. **Experimental**, not yet validated against a real device. Only the legacy 32-bit `LIST` / `SEND` / `RECV` variants are implemented; the newer 64-bit `_V2` variants (needed for files/listings beyond ~2.14GB) are tracked in [#8](https://github.com/CLDMV/droidsock/issues/8).

## Reboot Service

`"reboot:<mode>"` is a distinct top-level ADB service, structurally like `shell:` / `sync:` - not a shell command. Opening a stream to it (mode `""` / `"bootloader"` / `"recovery"` / `"sideload"` / `"sideload-auto-reboot"`, or a vendor-specific string) is itself the entire operation: once the device accepts the `OPEN`, the reboot is already triggered, and the client just closes its end of the stream (best-effort - the device may have already torn down the connection by the time the close is attempted). **Experimental** - built from the protocol spec, not yet validated against a real device. See [#1](https://github.com/CLDMV/droidsock/issues/1).

## Port Forwarding

`"tcp:<port>"` opens a stream directly to a TCP port on the device - the same client-initiated `OPEN` / `OKAY` mechanism as `shell:` / `sync:`, just a different destination string. Forwarding a local port (host → device) works by listening on that port with a plain Node `net.createServer` and, for each accepted connection, opening a `tcp:<devicePort>` stream and bridging bytes bidirectionally between the local socket and the ADB stream until either side closes or errors. **Experimental** - built from the protocol spec, not yet validated against a real device. See [#1](https://github.com/CLDMV/droidsock/issues/1).

### Reverse Port Forwarding

The reverse direction (device → host) needs one addition the forward direction doesn't: every stream covered above is client-initiated (droidsock sends the `OPEN`), but a reverse tunnel means the _device_ opens a fresh stream to us whenever a peer connects to the registered device port. The stream layer's `handlePacket()` now handles this case directly - an inbound `OPEN` (recognizable by `arg1 == 0`, since the device has no local id of ours to reference yet) allocates a local id, acks it with `OKAY`, and emits it as a `"remoteOpen"` event (`(stream, destination)`) on the stream manager, rather than routing it to an existing stream the way `OKAY`/`WRTE`/`CLSE` are.

Registering the tunnel itself is a normal client-initiated stream: `"reverse:forward:tcp:<devicePort>;tcp:<hostPort>"`, acked the same `OKAY` / `FAIL`-plus-message way every ADB host-service command-response is. Each subsequent device-initiated connection arrives via `handlePacket()`'s `remoteOpen` path with a destination of `"tcp:<hostPort>"`, which `reverse.mjs` matches against its own registration before opening a real local TCP connection and bridging bytes - a destination that doesn't match belongs to a different `reverse()` call's registration and is left alone. `close()` unregisters via `"reverse:killforward:tcp:<devicePort>"`, acked the same way. **Experimental** - built from the protocol spec, not yet validated against a real device. See [#1](https://github.com/CLDMV/droidsock/issues/1).

---

[← Back to README](../README.md)
