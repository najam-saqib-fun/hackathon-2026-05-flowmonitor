# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

FlowMon is a three-tier ISP traffic analytics platform:

1. **C++ layer** — two cooperating binaries: `pcap_processor` (reads PCAPs/live NICs, strips L2, sends L3 snapshots over a Unix socket) and `flow_monitor` (aggregates packets into bidirectional flows, runs nDPI for app detection, persists to MySQL).
2. **Node.js layer** (`backend/`) — Express REST API + WebSocket server on port 3000, backed by MySQL.
3. **Angular layer** (`frontend/`) — Material UI dashboard, lazy-loaded routes, WebSocket live feed.

---

## Build commands

### C++ binaries

```bash
# Standard build (nDPI must be installed system-wide via sudo make install)
cmake -S . -B build
cmake --build build -j"$(nproc)"
# Outputs: build/pcap_processor  build/flow_monitor

# Local nDPI (no sudo install — built into third_party/ndpi-install/)
PKG_CONFIG_PATH="$PWD/third_party/ndpi-install/lib/pkgconfig:$PKG_CONFIG_PATH" \
    cmake -S . -B build
cmake --build build -j"$(nproc)"
export LD_LIBRARY_PATH="$PWD/third_party/ndpi-install/lib:$LD_LIBRARY_PATH"
```

**nDPI version requirement**: nDPI 5.x only. `struct ndpi_proto` was reshaped in v5 (`proto.app_protocol` is nested); `ndpi_detection_giveup` lost its guess-flag args. Not compatible with nDPI 4.x.

```bash
# Build nDPI from source into local prefix
git clone --depth 1 https://github.com/ntop/nDPI.git third_party/nDPI
cd third_party/nDPI && ./autogen.sh && ./configure --prefix="$PWD/../ndpi-install"
make -j"$(nproc)" && make install
```

### Backend

```bash
cd backend && npm install
npm run dev      # nodemon hot-reload
npm start        # production
```

### Frontend

```bash
cd frontend && npm install
npm start        # ng serve → http://localhost:4200
npm run build    # production build (font inlining disabled; budget 5 MB)
```

---

## Running the system

### Live capture mode (most common)

```bash
# flow_monitor taps the NIC directly — no pcap_processor needed
sudo ./build/flow_monitor \
  --interface wlp1s0 \
  --mysql-host 127.0.0.1 --mysql-port 3306 \
  --mysql-user flowmon --mysql-pass '<your-db-password>' --mysql-db flowmon \
  --flow-timeout 60 --sync-interval 30 --verbose

# Add --rfmon for 802.11 monitor mode (open networks only; WPA2 unicast is encrypted)
sudo ./build/flow_monitor --interface wlp1s0 --rfmon ...
```

### PCAP replay mode

```bash
# Terminal 1
./build/flow_monitor --socket /tmp/flow_monitor.sock \
  --mysql-host 127.0.0.1 --mysql-user root --mysql-db flowmon --verbose

# Terminal 2
./build/pcap_processor --input mytraffic.pcap \
  --socket /tmp/flow_monitor.sock --batch-size 200 --verbose
```

### End-to-end smoke test

```bash
# Uses flowmon_test DB; can override with env vars MYSQL_USER, MYSQL_PASS, etc.
./test.sh mytraffic.pcap
```

### Config file alternative

```bash
./build/flow_monitor --config config.json --verbose
# config.json keys: socket_path, mysql_*, flow_timeout_seconds, ndpi_max_packets,
#                   sweep_every_packets, max_active_flows
```

---

## Architecture: IPC between C++ processes

`src/common.h` defines the wire format — a length-prefixed binary stream over `AF_UNIX`:

```
[uint32_t body_len][PacketMessage 50-byte header][payload of payload_len bytes]
```

`PacketMessage` is packed (no padding): `timestamp_us`(8) + `src_ip[16]`(16) + `dst_ip[16]`(16) + `src_port`(2) + `dst_port`(2) + `protocol`(1) + `ip_version`(1) + `packet_len`(2) + `payload_len`(2) = 50 bytes. EOF sentinel is `body_len = 0`.

IPv4 addresses occupy the first 4 bytes of the 16-byte `src_ip`/`dst_ip` fields (rest zero). IPv6 uses all 16 bytes. `ip_version` is 4 or 6.

`pcap_processor` passes the IP layer onwards (not raw L2). `flow_monitor`'s nDPI call also receives from the IP header — `ndpi_detection_process_packet` expects `payload = packet + ip_header_offset`.

---

## Architecture: flow_monitor internals

Key classes all live in `src/flow_monitor.cpp`:

- **`AppMappings`** — loaded once from `application_mappings` table; holds exact hosts, suffix hosts, exact IPs, and CIDR ranges (IPv4 only). Called in `apply_mapping_override()` after nDPI classification to override `flow.application`.
- **`NdpiContext`** — wraps `ndpi_init_detection_module`. One global instance; `flow_struct_size()` used for `calloc` of per-flow nDPI state.
- **`FlowDB`** — all MySQL I/O. `open()` connects, runs `create_schema()`, and `seed_app_mappings()` on startup. Uses `CLIENT_MULTI_STATEMENTS`; `exec()` must drain all result sets.
- **`FlowTracker`** — the core loop. `on_packet()` → `lookup_or_create()` → `run_ndpi()` → periodic `sweep_expired()` and `sync_active()`. Flows are keyed by canonical 5-tuple (smaller IP first, ties by port) to make both directions share one entry.

**Flow lifecycle:**
1. First packet → `lookup_or_create` allocates `Flow` with `calloc`'d `ndpi_flow_struct`. `ip_bytes_to_str(m.src_ip, m.ip_version)` converts the raw address bytes to a string for map key and DB storage.
2. Direction detection uses `memcmp(m.src_ip, f->src_ip_bytes, 16)` to handle both IPv4 and IPv6.
3. Each packet → `run_ndpi` feeds nDPI. Metadata only read from `protos.tls_quic` when `proto_is_tls_family()` is true — the `protos` union aliases DNS/other bytes to TLS `char*` pointers; reading them on non-TLS flows causes SIGSEGV.
4. After `ndpi_max_packets` (default 16) or protocol decided → `ndpi_detection_giveup`, `finalize_protocol`, `apply_mapping_override`. CIDR lookups only run for IPv4 flows (all seeded CIDRs are IPv4).
5. Every `sweep_every_packets` (default 1000) → `sweep_expired` finalizes flows idle > `flow_timeout_seconds`. `finalize_and_persist` assigns IPDR keys; takes `now_us` so `ipdr_keys_[lk].last_seen_us = now_us` (not `f.last_packet_time_us`) preventing immediate re-expiry.
6. Every `sync_interval_seconds` (wall clock) → `sync_active` upserts active flows to DB for live visibility. Also refreshes `ipdr_keys_[lk].last_seen_us = now_us` for each active flow to prevent IPDR keys from expiring during long-running sessions (e.g. YouTube streams).

**IPDR key semantics:** An IPDR key represents a session: `(src_ip, dst_ip, dst_port, application)`. The in-memory map `ipdr_keys_` stores `last_seen_us = now_us` (sweep time, not packet time) so the key survives until 60 s pass with *no new flows* being finalized for it. `sync_active()` also updates `last_seen_us` so IPDR keys stay alive while the parent flow is still active. `ipdr_update` uses `LEAST(first_seen,…)` / `GREATEST(last_seen,…)` to stay monotonic when multiple flows for the same key finalize out of order.

---

## Architecture: backend

`backend/src/db.js` — mysql2 promise pool (20 connections). `ensureSchema()` called on server start; seeds `admin` / `admin123` if `users` is empty.

`backend/src/websocket.js` — authenticated via JWT query param `?token=`. Pushes `{type:'live_update', data:{live_flows, overview, top_apps, top_talkers}}` every `WS_PUSH_INTERVAL_MS` ms. `live_flows` query joins `application_mappings` subquery for category (column was removed from `flows` table; derived at query time).

`application_category` **no longer exists as a column** in `flows`. All queries that need it must LEFT JOIN: `(SELECT application, MIN(category) AS category FROM application_mappings GROUP BY application) am ON am.application = f.application`.

---

## Architecture: frontend

Standalone Angular 17 components with lazy-loaded routes. All API calls go through `src/app/core/services/api.service.ts`. Auth token stored in `localStorage['token']`; `AuthInterceptor` attaches it as `Bearer` header.

`FlowDetailModalComponent` is declared inline in the same file as its parent and opened via `MatDialog` — not via `window.open`. All modal dialogs use `panelClass: 'dark-dialog'` (defined in `src/styles.scss`).

`fmtApp(app, hostnames)` helper (in `flows.component.ts` and `dashboard.component.ts`): if `app` starts with `NetBIOS`, appends `{first_hostname}` from the JSON `hostnames` array.

---

## Database notes

Schema is auto-created by `flow_monitor` on first run AND by the Node.js backend on startup. Both definitions must stay in sync when adding columns.

`flows.flow_hash` = MD5 of the canonical 5-tuple + `start_time_us`. Same 5-tuple appearing later creates a new row (different hash), not an overwrite. The `ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)` trick returns the row ID whether inserted or updated.

`total_packets` and `total_bytes` are MySQL `GENERATED ALWAYS AS ... STORED` computed columns — never write to them directly.

Migrations in `create_schema()` (C++) and `ensureSchema()` (Node.js) are wrapped in bare `exec()`/try-catch so they're idempotent — "Duplicate column name" errors are printed but ignored.

---

## Backend environment (`backend/.env`)

```
PORT=3000
DB_HOST=127.0.0.1  DB_PORT=3306  DB_USER=root  DB_PASS=<your-db-password>  DB_NAME=flowmon
JWT_SECRET=change-me-to-a-long-random-secret
JWT_EXPIRES_IN=24h
WS_PUSH_INTERVAL_MS=3000
GEOIP_DB_PATH=          # optional MaxMind GeoLite2 path
```
