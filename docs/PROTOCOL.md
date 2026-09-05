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
- **`LIST`** (binary-safe directory listing): the request follows the generic frame shape (id + path length + path). Responses are a different shape - `DENT` entries pack four 4-byte fields (mode, size, mtime, namelen) before the variable-length name, not the generic id+value+payload layout - followed by a `DONE` (generic shape) once the listing is complete, or a `FAIL` on error. If the stream closes or errors before a `DONE` / `FAIL` arrives (a real disconnect or protocol error), the frame reader rejects rather than waiting forever. **Experimental**, not yet validated against a real device.

### SYNC V2 (64-bit) variants

The legacy `SEND` / `RECV` / `LIST` commands above use 32-bit size fields, capping a single file or directory entry around ~2.14GB. `SEND_V2` / `RECV_V2` / `STAT_V2` / `LIST_V2` lift that ceiling with 64-bit fields. Implemented from AOSP `packages/modules/adb/file_sync_protocol.h` - **experimental**, not yet validated against a real device. See [#8](https://github.com/CLDMV/droidsock/issues/8).

Only usable against a device that advertised the corresponding CNXN feature (`sendrecv_v2` for send/recv, `stat_v2`, `ls_v2`) - droidsock declares these in its own outgoing CNXN banner (`device::features=...`) so a device that gates V2 support on the client's declared features offers it.

Every V2 command uses a new 4-character id (`SND2` / `RCV2` / `STA2` / `LIS2` / `DNT2`) for its setup/request/response frames; the `DATA` / `DONE` / `OKAY` / `FAIL` / `QUIT` frames that carry the actual chunk transfer are byte-for-byte identical in id and shape to the legacy ones above, reused unchanged:

- **`SEND_V2`**: two frames, not one. First, a generic `SND2` frame carrying just the destination path (same shape as legacy `SEND`'s path, but without the `,<mode>` suffix). Second, a raw 12-byte `sync_send_v2` struct sent with no id+value+payload envelope: 4-byte id (`SND2` again) + 4-byte mode + 4-byte flags (little-endian). `flags` selects per-transfer compression (`kSyncFlagBrotli` = 1 / `kSyncFlagLZ4` = 2 / `kSyncFlagZstd` = 4, or `0` for none) - droidsock implements brotli (`options.compression: "brotli"`, opt-in and off by default), using Node's built-in `zlib.brotliCompress()` (the async form, via `util.promisify`, so compressing a chunk doesn't block the event loop) per `DATA` chunk; lz4/zstd aren't implemented (they'd need new dependencies) - tracked separately in a follow-up to [#8](https://github.com/CLDMV/droidsock/issues/8). `DATA` chunks and the terminating `DONE` (mtime) follow exactly as in legacy `SEND` - each chunk's payload is brotli-compressed independently when `compression: "brotli"` is requested, chunked by _uncompressed_ size (capped at 48KB rather than the full 64KB `DATA` ceiling, leaving headroom for brotli's worst-case expansion on incompressible input) before compressing - and the final ack is the same generic `OKAY`/`FAIL` shape.
- **`RECV_V2`**: same two-frame shape - a generic `RCV2` path frame, then a raw 8-byte struct (4-byte id + 4-byte flags, no envelope) requesting the same compression options as `SEND_V2`. The device then streams `DATA` (each chunk brotli-decompressed on receipt when requested) + `DONE` exactly as in legacy `RECV`.
- **`STAT_V2`** / **`LIST_V2`**: request is a single generic frame (id + path length + path), same shape as legacy `LIST`'s request. `STAT_V2`'s reply is a single raw 72-byte `sync_stat_v2` struct (no envelope): id(4) + error(4) + dev(8) + ino(8) + mode(4) + nlink(4) + uid(4) + gid(4) + size(8) + atime(8) + mtime(8) + ctime(8), all little-endian - a non-zero `error` field (rather than a separate `FAIL` frame) signals failure. `LIST_V2`'s `DNT2` entries are the same shape minus `id`, plus a trailing 4-byte `namelen` and the variable-length name, terminated by a generic `DONE` (or `FAIL`) exactly like legacy `LIST`.

`size` / `atime` / `mtime` / `ctime` / `dev` / `ino` are returned as `BigInt` (`statV2()`/`listV2()`), since the entire point of the V2 variants is representing values beyond `Number.MAX_SAFE_INTEGER`.

## Reboot Service

`"reboot:<mode>"` is a distinct top-level ADB service, structurally like `shell:` / `sync:` - not a shell command. Opening a stream to it (mode `""` / `"bootloader"` / `"recovery"` / `"sideload"` / `"sideload-auto-reboot"`, or a vendor-specific string) is itself the entire operation: once the device accepts the `OPEN`, the reboot is already triggered, and the client just closes its end of the stream (best-effort - the device may have already torn down the connection by the time the close is attempted). **Experimental** - built from the protocol spec, not yet validated against a real device. See [#1](https://github.com/CLDMV/droidsock/issues/1).

## Streaming APK Install

`"exec:cmd package install -S <size>"` opens a stream the same way `shell:`/`sync:` do (client `OPEN`, device `OKAY`), but `exec:` runs the command with its stdout/stdin _not_ subject to a pty (unlike `shell:`), and the client writes the raw APK bytes directly as the command's stdin over `WRTE` frames - no on-device file is ever written. The `-S <size>` flag tells `pm install` exactly how many stdin bytes to expect, which is what makes this work without any explicit stdin-EOF signal (ADB streams have no half-close). The device streams `pm install`'s text output back over the same stream and closes it when done. Only usable against a device that advertised the `cmd` CNXN feature. **Experimental** - built from the protocol spec, not yet validated against a real device. See [#1](https://github.com/CLDMV/droidsock/issues/1) and [#7](https://github.com/CLDMV/droidsock/issues/7).

## Port Forwarding

`"tcp:<port>"` opens a stream directly to a TCP port on the device - the same client-initiated `OPEN` / `OKAY` mechanism as `shell:` / `sync:`, just a different destination string. Forwarding a local port (host → device) works by listening on that port with a plain Node `net.createServer` and, for each accepted connection, opening a `tcp:<devicePort>` stream and bridging bytes bidirectionally between the local socket and the ADB stream until either side closes or errors. **Experimental** - built from the protocol spec, not yet validated against a real device. See [#1](https://github.com/CLDMV/droidsock/issues/1).

### Reverse Port Forwarding

The reverse direction (device → host) needs one addition the forward direction doesn't: every stream covered above is client-initiated (droidsock sends the `OPEN`), but a reverse tunnel means the _device_ opens a fresh stream to us whenever a peer connects to the registered device port. The stream layer's `handlePacket()` now handles this case directly - an inbound `OPEN` (recognizable by `arg1 == 0`, since the device has no local id of ours to reference yet) allocates a local id, acks it with `OKAY`, and emits it as a `"remoteOpen"` event (`(stream, destination)`) on the stream manager, rather than routing it to an existing stream the way `OKAY`/`WRTE`/`CLSE` are.

Registering the tunnel itself is a normal client-initiated stream: `"reverse:forward:tcp:<devicePort>;tcp:<hostPort>"`, acked the same `OKAY` / `FAIL`-plus-message way every ADB host-service command-response is. Each subsequent device-initiated connection arrives via `handlePacket()`'s `remoteOpen` path with a destination of `"tcp:<hostPort>"`, which `reverse.mjs` matches against its own registration before opening a real local TCP connection and bridging bytes - a destination that doesn't match belongs to a different `reverse()` call's registration and is left alone. `close()` unregisters via `"reverse:killforward:tcp:<devicePort>"`, acked the same way. **Experimental** - built from the protocol spec, not yet validated against a real device. See [#1](https://github.com/CLDMV/droidsock/issues/1).

## Wi-Fi Pairing

The PIN-based pairing flow Android 11+ uses for wireless debugging (`adb pair host:port pairing-code`) is a **completely separate protocol** from everything above - no CNXN/AUTH framing, no shared connection state with the rest of droidsock beyond reusing the same persistent RSA identity `auth.getKeys()` manages. It exists to get that identity's public key written into the device's `adb_keys` trust store automatically (the same store a manual "Allow this computer?" tap on the classic flow populates), authenticated by the 6-digit code shown on the device instead of a user tap.

The session itself is a raw TLS 1.3 connection from the first byte (both `minVersion`/`maxVersion` pinned to TLS 1.3), with peer certificate verification disabled - trust here comes from the shared pairing code via a SPAKE2 key exchange, not from the TLS certificate. That exchange runs over `PairingPacket` framing (a 6-byte header - version, type, big-endian payload length - followed by the payload) carrying two message types: a `SPAKE2_MSG` exchange, then an AES-128-GCM-encrypted `PEER_INFO` exchange once both sides have derived the shared session key. A successful decrypt of the device's `PEER_INFO` reply is what actually confirms pairing succeeded.

The SPAKE2 construction itself is BoringSSL's bespoke SPAKE2-over-edwards25519 (**not** RFC 9382's NIST-curve SPAKE2) - built from `@noble/curves`'s Ed25519 primitives directly. Its password is channel-bound: the TLS session's exported keying material is appended to the pairing code before hashing, cryptographically tying the exchange to that specific TLS session so it can't be relayed between separately-terminated connections.

**Experimental**, same as the rest of this document, but sourced unusually directly - every constant here (the curve, mask points, password-scalar derivation, key-derivation transcript order, the `PairingPacketHeader` layout including its version byte, the `PeerInfo` struct, and the AES-128-GCM cipher's key derivation and nonce construction) is confirmed against AOSP/BoringSSL source, cross-checked across multiple independent reads - see `pairing.mjs`'s own top-of-file comment. Not yet validated against a real device. See [#1](https://github.com/CLDMV/droidsock/issues/1).

---

[← Back to README](../README.md)
