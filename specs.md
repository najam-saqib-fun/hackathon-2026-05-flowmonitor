# FlowMon — Technical Specifications

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Architecture](#2-architecture)
3. [C++ Layer](#3-c-layer)
4. [IPC Wire Protocol](#4-ipc-wire-protocol)
5. [Database Schema](#5-database-schema)
6. [Node.js Backend](#6-nodejs-backend)
7. [REST API Reference](#7-rest-api-reference)
8. [WebSocket Protocol](#8-websocket-protocol)
9. [Angular Frontend](#9-angular-frontend)
10. [Configuration](#10-configuration)
11. [Build & Deploy](#11-build--deploy)
12. [Security](#12-security)
13. [Constraints & Known Limitations](#13-constraints--known-limitations)

---

## 1. System Overview

FlowMon is a three-tier ISP traffic analytics platform for real-time and historical network flow analysis.

| Tier | Technology | Role |
|------|-----------|------|
| C++ | libpcap + nDPI 5.x + MySQL C API | Packet capture, flow aggregation, DPI, DB persistence |
| Node.js | Express 4 + ws + mysql2 | REST API, WebSocket push, alert evaluation |
| Angular | Angular 17 + Angular Material + Chart.js | Operator dashboard and management UI |

**Key capabilities:**
- Live NIC capture or PCAP file replay
- Bidirectional flow tracking with nDPI deep-packet inspection
- Per-subscriber traffic attribution
- IPDR (IP Detail Record) session tracking for regulatory compliance
- Real-time dashboard with 3-second WebSocket push
- Capture policy (per-application allowlist)
- Threshold-based alerting

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  CAPTURE TIER (C++)                                                  │
│                                                                      │
│   ┌─────────────────┐   AF_UNIX binary frames   ┌────────────────┐ │
│   │ pcap_processor  │ ─────────────────────────► │ flow_monitor   │ │
│   │  libpcap read   │                            │  nDPI DPI      │ │
│   │  L2 strip       │  (PCAP replay mode only)   │  flow table    │ │
│   │  L3 snapshot    │                            │  MySQL writer  │ │
│   └─────────────────┘                            └───────┬────────┘ │
│                                                          │           │
│   Live mode: flow_monitor taps NIC directly (no pcap_processor)     │
└──────────────────────────────────────────────────────────┼──────────┘
                                                           │ MySQL
                                                ┌──────────▼──────────┐
                                                │   MySQL: flowmon    │
                                                │  flows, hostnames,  │
                                                │  applications_sum-  │
                                                │  mary, ipdr_keys,   │
                                                │  subscribers, …     │
                                                └──────────┬──────────┘
                                                           │
┌──────────────────────────────────────────────────────────┼──────────┐
│  API TIER (Node.js :3000)                                │           │
│                                                          │           │
│   Express REST ◄──────── HTTP/S ──────────────┐  mysql2  │           │
│   WebSocket /ws ◄─────── WS ──────────────────┤          │           │
│                                               │          │           │
└───────────────────────────────────────────────┼──────────┘──────────┘
                                                │
┌───────────────────────────────────────────────┼──────────────────────┐
│  UI TIER (Angular :4200)                      │                       │
│                                               │                       │
│   Dashboard ─── Top Apps/Talkers/KPIs ────────┘                      │
│   Flow Explorer ─── Paginated search                                 │
│   IPDR ─── Session records                                           │
│   Subscribers ─── IP→ID mapping                                      │
│   Mappings ─── App classification rules                              │
│   Policy ─── Per-app capture control                                 │
│   Alerts ─── Rules + events                                          │
│   Domains ─── Hostname resolution history                            │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 3. C++ Layer

### 3.1 `pcap_processor`

Reads a PCAP file (or live interface as a secondary mode), strips L2 headers, and sends L3 snapshots to `flow_monitor` over a Unix domain socket.

**Supported link-layer types:**
- `DLT_EN10MB` — Ethernet (with optional VLAN 802.1Q/QinQ stripping)
- `DLT_RAW` — raw IP
- `DLT_LINUX_SLL` / `DLT_LINUX_SLL2` — Linux cooked capture
- `DLT_IEEE802_11_RADIO` — Radiotap + 802.11 (monitor mode)

**Packet path:**
1. `pcap_next_ex()` → raw frame
2. `l3_offset(linktype, pkt, caplen)` → byte offset to IP header
3. Peek at IP version nibble → IPv4 (`ip` header) or IPv6 (`ip6_hdr`)
4. For IPv6: walk extension headers (HopByHop, Routing, Destination) to find transport header
5. Build `PacketMessage` + copy IP payload up to `--max-payload` bytes
6. Write length-prefixed frame to Unix socket

**CLI flags:**

| Flag | Default | Description |
|------|---------|-------------|
| `--input FILE` | — | PCAP file to replay |
| `--socket PATH` | `/tmp/flow_monitor.sock` | Unix socket to connect to |
| `--batch-size N` | 200 | Max packets per write batch |
| `--max-payload N` | 3072 | Max L3 payload bytes captured per packet |
| `--filter EXPR` | — | BPF filter expression |
| `--verbose` | false | Print per-packet debug output |

---

### 3.2 `flow_monitor`

Long-running daemon. Two operating modes:

- **Socket mode** — reads `PacketMessage` frames from a Unix socket (fed by `pcap_processor`)
- **Live mode** — opens a NIC directly via `pcap_open_live()` / `pcap_open_live()` with optional `--rfmon`

**Startup sequence:**
1. Parse CLI flags / config file
2. Connect to MySQL; call `create_schema()` + `seed_app_mappings()`
3. Load `AppMappings` from `application_mappings` table
4. Load `capture_policy` if table has rows → set `policy_active_`
5. Open socket / NIC
6. Enter packet loop

**Key classes:**

| Class | Responsibility |
|-------|---------------|
| `AppMappings` | Loaded once at startup; holds exact-host, suffix-host, exact-IP, CIDR rules for override after nDPI |
| `NdpiContext` | Wraps `ndpi_init_detection_module()`; one global instance |
| `FlowDB` | All MySQL I/O — schema creation, seed, upsert, summary |
| `FlowTracker` | Core loop: `on_packet()`, `sweep_expired()`, `sync_active()` |

**Flow lifecycle:**

```
Packet arrives
      │
      ▼
lookup_or_create(5-tuple)
      │
  new flow? ─► alloc Flow, calloc ndpi_flow_struct
      │
      ▼
run_ndpi(packet, flow)
      │
  proto decided? ──► finalize_protocol() → apply_mapping_override()
      │
  packets_seen >= ndpi_max_packets? ──► ndpi_detection_giveup() → same
      │
      ▼
Every sweep_every_packets:
  sweep_expired() ──► finalize_and_persist() → update_app_summary() → assign_ipdr_key()

Every sync_interval_seconds (wall clock):
  sync_active() ──► upsert active flows, refresh IPDR last_seen
```

**Canonical flow key:** `min(src_ip, dst_ip) + max(src_ip, dst_ip) + src_port + dst_port + protocol`
(smaller IP first; ties broken by port). Both directions share one `Flow` entry.

**Direction detection:** `memcmp(m.src_ip, f->src_ip_bytes, 16)` — works for both IPv4 and IPv6.

**nDPI safety rule:** Only read `protos.tls_quic.*` fields when `proto_is_tls_family()` is true. The `protos` union aliases DNS/other bytes to TLS `char*` pointers — reading on non-TLS flows causes SIGSEGV.

**IPDR key semantics:** `(src_ip, dst_ip, dst_port, application)`. `last_seen_us` is set to `now_us` (sweep time, not packet time) to prevent immediate re-expiry. `sync_active()` also refreshes `last_seen_us` on every cycle so keys survive long-running sessions (e.g. YouTube streams).

---

## 4. IPC Wire Protocol

Defined in `src/common.h`. Framing over AF_UNIX stream socket:

```
┌─────────────────────┬──────────────────────────────────────────────┐
│  uint32_t body_len  │  PacketMessage (50 bytes)  │  payload bytes  │
│  (host byte order)  │  (packed, no padding)       │  (payload_len)  │
└─────────────────────┴──────────────────────────────────────────────┘
```

`body_len = 0` is the EOF sentinel.

**`PacketMessage` layout (50 bytes, `#pragma pack(1)`):**

| Offset | Size | Field | Notes |
|--------|------|-------|-------|
| 0 | 8 | `timestamp_us` | Microseconds since epoch |
| 8 | 16 | `src_ip[16]` | IPv4: bytes 0–3, rest zero; IPv6: full 16 bytes |
| 24 | 16 | `dst_ip[16]` | Same layout |
| 40 | 2 | `src_port` | Host byte order |
| 42 | 2 | `dst_port` | Host byte order |
| 44 | 1 | `protocol` | `IPPROTO_TCP`=6, `IPPROTO_UDP`=17, `IPPROTO_ICMP`=1, … |
| 45 | 1 | `ip_version` | 4 or 6 |
| 46 | 2 | `packet_len` | IP total length (original frame size) |
| 48 | 2 | `payload_len` | Bytes appended after header |

The payload is the raw L3 packet (starting at the IP header) for nDPI. `ndpi_detection_process_packet` receives `payload = pkt + ip_header_offset`.

---

## 5. Database Schema

Created by `flow_monitor` on first run (`create_schema()`) **and** by the Node.js backend (`ensureSchema()`) — both use `CREATE TABLE IF NOT EXISTS`, so either can initialize the schema.

### `flows`

Primary table. One row per unique bidirectional flow (`flow_hash` = MD5 of canonical 5-tuple + `start_time_us`).

| Column | Type | Notes |
|--------|------|-------|
| `id` | BIGINT UNSIGNED PK | Auto-increment |
| `flow_hash` | VARCHAR(32) UNIQUE | MD5 of canonical key |
| `src_ip` | VARCHAR(45) | Dot-decimal IPv4 or colon-hex IPv6 |
| `dst_ip` | VARCHAR(45) | |
| `src_port` | SMALLINT UNSIGNED | |
| `dst_port` | SMALLINT UNSIGNED | |
| `protocol` | TINYINT UNSIGNED | IPPROTO_* values |
| `application` | VARCHAR(255) | nDPI name or mapping override |
| `start_time` | DATETIME(6) | First packet |
| `end_time` | DATETIME(6) | Last packet (updated on sync) |
| `flow_duration_ms` | DOUBLE | Derived from start/end |
| `packet_sent` | BIGINT UNSIGNED | Packets from src→dst |
| `packet_recv` | BIGINT UNSIGNED | Packets from dst→src |
| `bytes_sent` | BIGINT UNSIGNED | Bytes src→dst |
| `bytes_recv` | BIGINT UNSIGNED | Bytes dst→src |
| `total_packets` | BIGINT GENERATED | `packet_sent + packet_recv` (STORED) |
| `total_bytes` | BIGINT GENERATED | `bytes_sent + bytes_recv` (STORED) |
| `hostnames` | JSON | Array of resolved hostnames/SNIs |
| `urls` | JSON | Extracted HTTP URLs |
| `metadata` | JSON | TLS version, JA3, ALPN, cert info |
| `ipdr_key_id` | BIGINT UNSIGNED | FK to `ipdr_keys` |
| `updated_at` | TIMESTAMP | Updated on every `sync_active` upsert |

**Important:** `total_packets` and `total_bytes` are `GENERATED ALWAYS AS ... STORED` — never write to them directly.

**`application_category` does not exist** as a column. Category must be derived at query time via:
```sql
LEFT JOIN (
  SELECT application, MIN(category) AS category
  FROM application_mappings GROUP BY application
) am ON am.application = f.application
```

---

### `applications_summary`

Rolling per-application counters. Updated only on flow finalization (not on `sync_active` upserts) to prevent double-counting.

| Column | Type |
|--------|------|
| `id` | BIGINT UNSIGNED PK |
| `application` | VARCHAR(255) UNIQUE |
| `category` | VARCHAR(255) |
| `total_flows` | BIGINT UNSIGNED |
| `total_packets_sent` | BIGINT UNSIGNED |
| `total_packets_recv` | BIGINT UNSIGNED |
| `total_bytes_sent` | BIGINT UNSIGNED |
| `total_bytes_recv` | BIGINT UNSIGNED |
| `total_duration_ms` | DOUBLE |
| `first_seen` | DATETIME(6) |
| `last_seen` | DATETIME(6) |
| `last_updated` | TIMESTAMP |

---

### `application_mappings`

Operator-defined classification rules. Evaluated after nDPI by `apply_mapping_override()`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INT UNSIGNED PK | |
| `pattern_type` | ENUM | `hostname_exact`, `hostname_suffix`, `ip_exact`, `ip_cidr` |
| `pattern` | VARCHAR(512) | Stored lowercase |
| `application` | VARCHAR(255) | Override value for `f.application` |
| `category` | VARCHAR(255) | Business category (Streaming, Social, …) |
| `priority` | INT | Higher wins; default 100 |
| `notes` | TEXT | |

Matching order: exact-IP → CIDR (IPv4 only) → exact-hostname → suffix-hostname.

---

### `ipdr_keys`

Long-lived IPDR session records. Key = `(src_ip, dst_ip, dst_port, application)`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | BIGINT UNSIGNED PK | |
| `key_string` | VARCHAR(512) | Human-readable composite key |
| `src_ip` | VARCHAR(45) | |
| `dst_ip` | VARCHAR(45) | |
| `dst_port` | INT UNSIGNED | |
| `application` | VARCHAR(255) | |
| `packets_sent/recv` | BIGINT UNSIGNED | Cumulative |
| `bytes_sent/recv` | BIGINT UNSIGNED | Cumulative; uses `LEAST`/`GREATEST` merge |
| `first_seen` | DATETIME(6) | `LEAST(existing, new)` |
| `last_seen` | DATETIME(6) | `GREATEST(existing, new)`, updated by `sync_active` |
| `status` | ENUM | `active` or `closed` |

---

### `subscribers`

Maps IP addresses to subscriber identifiers.

| Column | Type |
|--------|------|
| `id` | INT UNSIGNED PK |
| `ip_address` | VARCHAR(45) UNIQUE |
| `subscriber_id` | VARCHAR(128) |
| `name` | VARCHAR(255) |
| `notes` | TEXT |

---

### `capture_policy`

Per-application allowlist for `flow_monitor`. Empty table = capture everything.

| Column | Type |
|--------|------|
| `application` | VARCHAR(255) PK |
| `enabled` | TINYINT(1) DEFAULT 1 |

C++ polls this table inside every `sync_active()` call (~30 s). Non-empty table activates `policy_active_ = true`; only flows whose `application` has `enabled=1` are persisted.

---

### `alert_rules` / `alert_events`

Alert threshold rules and their trigger history. Evaluated every 30 s by the Node.js WebSocket server.

**`alert_rules` columns:** `id`, `name`, `metric` (ENUM), `threshold`, `window_seconds`, `application`, `src_ip`, `dst_ip`, `protocol`, `enabled`, `created_by`, `created_at`.

**Metrics:** `bytes_per_sec`, `flows_per_min`, `conn_per_ip`, `unusual_port`.

**`alert_events` columns:** `id`, `rule_id`, `triggered_at`, `metric_value`, `details` (JSON), `acknowledged`.

---

### `hostnames`

TLS SNI, HTTP Host headers, DNS query names extracted per flow.

| Column | Type |
|--------|------|
| `id` | BIGINT UNSIGNED PK |
| `hostname` | VARCHAR(512) |
| `flow_id` | BIGINT UNSIGNED FK → `flows.id` ON DELETE CASCADE |
| `first_seen` / `last_seen` | DATETIME(6) |
| `resolution_count` | INT UNSIGNED |

---

### `users`

Authentication table.

| Column | Type |
|--------|------|
| `id` | INT UNSIGNED PK |
| `username` | VARCHAR(64) UNIQUE |
| `password_hash` | VARCHAR(255) bcrypt |
| `role` | ENUM `admin`, `viewer` |
| `created_at` | TIMESTAMP |
| `last_login` | TIMESTAMP |

Default seed: `admin` / `admin123` (role: admin) — change before production.

---

## 6. Node.js Backend

**Entry point:** `backend/src/index.js`  
**Port:** `3000` (configurable via `PORT` env var)  
**DB pool:** `mysql2/promise`, 20 connections, `timezone: 'local'`

### Startup sequence

1. `dotenv` loads `backend/.env`
2. `getPool()` → `ensureSchema()` creates missing tables, runs idempotent migrations, seeds default admin
3. `createWsServer(server)` starts WebSocket on `/ws`
4. HTTP server listens on `PORT`

### Middleware stack

```
helmet (no CSP)  →  CORS (*)  →  express.json()  →  rate-limit (login only)  →  routes
```

### Route registration

| Mount | Module |
|-------|--------|
| `/api/auth` | `routes/auth.js` |
| `/api/flows` | `routes/flows.js` |
| `/api/stats` | `routes/stats.js` |
| `/api/alerts` | `routes/alerts.js` |
| `/api/domains` | `routes/domains.js` |
| `/api/mappings` | `routes/mappings.js` |
| `/api/subscribers` | `routes/subscribers.js` |
| `/api/ipdr` | `routes/ipdr.js` |
| `/api/policy` | `routes/policy.js` |

### Auth middleware

`requireAuth` — verifies `Authorization: Bearer <jwt>` header using `JWT_SECRET`. Attaches `req.user = { id, username, role }`.

`requireAdmin` — additionally checks `req.user.role === 'admin'`. Used on all write endpoints.

---

## 7. REST API Reference

All endpoints except `/api/auth/login` and `/api/health` require `Authorization: Bearer <jwt>`.

Write operations (POST/PUT/DELETE) additionally require `role=admin`.

---

### Auth

| Method | Path | Body | Description |
|--------|------|------|-------------|
| POST | `/api/auth/login` | `{ username, password }` | Returns `{ token, user }` |
| GET | `/api/auth/me` | — | Returns current user info |
| GET | `/api/auth/users` | — | List all users (admin only) |
| POST | `/api/auth/users` | `{ username, password, role }` | Create user (admin only) |

---

### Flows

| Method | Path | Query params | Description |
|--------|------|-------------|-------------|
| GET | `/api/flows` | `src_ip`, `dst_ip`, `application`, `category`, `protocol`, `src_port`, `dst_port`, `subscriber`, `classified`, `start`, `end`, `sort`, `order`, `limit`, `offset` | Paginated flow list |
| GET | `/api/flows/live` | `seconds` (max 300, def 30) | Flows active in last N seconds |
| GET | `/api/flows/:id` | — | Single flow with hostname/URL detail |

**Response shape (list):** `{ total, limit, offset, rows: [...] }`

Each row includes: `id`, `src_ip`, `dst_ip`, `src_port`, `dst_port`, `protocol`, `application`, `application_category` (derived via JOIN), `subscriber_id`, `subscriber_name`, `bytes_sent`, `bytes_recv`, `total_bytes`, `total_packets`, `start_time`, `updated_at`, `_unclassified`.

---

### Stats

| Method | Path | Query params | Description |
|--------|------|-------------|-------------|
| GET | `/api/stats/overview` | `start`, `end` | KPI totals: flows, bytes, packets, unique IPs, unique apps, last-60s metrics |
| GET | `/api/stats/top-apps` | `start`, `end`, `limit`, `by` | Top apps from `applications_summary` + category JOIN |
| GET | `/api/stats/top-talkers` | `start`, `end`, `limit` | Top source and dest IPs by bytes; sources include `subscriber_id` |
| GET | `/api/stats/bandwidth` | `granularity` (minute/hour), `limit` | Time-series bytes per bucket |
| GET | `/api/stats/protocol-distribution` | `start`, `end` | Bytes + flows per protocol number |
| GET | `/api/stats/history` | `period` (hourly/daily/monthly) | Historical aggregates |
| GET | `/api/stats/anomalies` | — | Bandwidth spikes, port scanners, new apps in last 24h |
| GET | `/api/stats/app-detection` | — | Detection rate, by-category breakdown |

---

### Alerts

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/alerts/rules` | List all rules (with creator username) |
| POST | `/api/alerts/rules` | Create rule |
| PUT | `/api/alerts/rules/:id` | Update rule |
| DELETE | `/api/alerts/rules/:id` | Delete rule |
| GET | `/api/alerts/events` | Events; filter by `acknowledged=0|1`, `limit`, `offset` |
| POST | `/api/alerts/events/:id/acknowledge` | Mark event acknowledged |

**Rule body:** `{ name, metric, threshold, window_seconds, application?, src_ip?, dst_ip?, protocol? }`

---

### Domains

| Method | Path | Query params | Description |
|--------|------|-------------|-------------|
| GET | `/api/domains` | `search`, `src_ip`, `start`, `end`, `limit`, `offset` | Paginated hostname records |
| GET | `/api/domains/chart` | `start`, `end`, `limit` | Top domains by occurrence for charting |
| GET | `/api/domains/unique-sources` | — | Distinct source IPs for filter dropdown |

---

### Application Mappings

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/mappings` | Paginated list; filter by `search`, `pattern_type`, `application` |
| GET | `/api/mappings/applications?q=` | Distinct app names matching query (autocomplete) |
| POST | `/api/mappings` | Create mapping |
| PUT | `/api/mappings/:id` | Update mapping |
| DELETE | `/api/mappings/:id` | Delete mapping |
| POST | `/api/mappings/import` | Bulk import; body `{ format: 'csv'|'json', data: string }` |
| GET | `/api/mappings/export?format=csv|json` | Download all mappings |

---

### Subscribers

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/subscribers` | Paginated list; filter by `search`, `subscriber_id` |
| POST | `/api/subscribers` | Create subscriber |
| PUT | `/api/subscribers/:id` | Update subscriber |
| DELETE | `/api/subscribers/:id` | Delete subscriber |
| POST | `/api/subscribers/import` | Bulk import CSV/JSON |
| GET | `/api/subscribers/export?format=csv|json` | Download |

---

### IPDR

| Method | Path | Query params | Description |
|--------|------|-------------|-------------|
| GET | `/api/ipdr` | `src_ip`, `dst_ip`, `application`, `subscriber`, `status`, `key_string`, `sort`, `order`, `limit`, `offset` | Paginated IPDR keys with subscriber + category |
| GET | `/api/ipdr/:id/flows` | — | All flows belonging to an IPDR key |

---

### Capture Policy

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/policy` | All apps from `applications_summary` UNION `capture_policy`-only entries; with enabled status |
| PUT | `/api/policy/:application` | Upsert single rule; body `{ enabled: 0|1 }` |
| POST | `/api/policy/bulk` | Batch upsert; body `{ updates: [{application, enabled}] }` |

---

### Misc

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | DB ping; returns `{ status: 'ok', ts }` |
| GET | `/api` | Endpoint index |

---

## 8. WebSocket Protocol

**URL:** `ws://<host>/ws?token=<jwt>`

Auth via JWT query parameter. Connection rejected (close 1008) if token invalid.

### Server → Client messages

**`live_update`** — pushed every `WS_PUSH_INTERVAL_MS` ms (default 3000):

```json
{
  "type": "live_update",
  "ts": 1714000000000,
  "data": {
    "live_flows": [...],
    "overview": { "total_flows": 0, "total_bytes": 0, ... },
    "top_apps": [{ "application": "YouTube", "category": "Streaming", "total_bytes": 0, "flows": 0 }],
    "top_talkers": [{ "ip": "192.168.1.1", "total_bytes": 0, "flows": 0 }],
    "bandwidth": [{ "bucket": "2024-04-25 10:30:00", "flows": 0, "bytes": 0 }]
  }
}
```

**`alert`** — broadcast to all clients when an alert rule triggers:

```json
{
  "type": "alert",
  "ts": 1714000000000,
  "data": { "rule_id": 1, "rule_name": "High bandwidth", "metric": "bytes_per_sec", "value": 5000000, "threshold": 1000000 }
}
```

### Client → Server messages

| Type | Effect |
|------|--------|
| `{ "type": "subscribe" }` | Start push timer (if not already running) |
| `{ "type": "unsubscribe" }` | Stop push timer |

Push timer starts automatically on connect; no explicit subscribe needed.

### Alert evaluation (server-side, every 30 s)

| Metric | Query |
|--------|-------|
| `bytes_per_sec` | `SUM(total_bytes) / window_seconds` from flows in window |
| `flows_per_min` | `COUNT(*) / (window / 60.0)` |
| `conn_per_ip` | `MAX(flow count per src_ip)` in window |
| `unusual_port` | Count of flows to non-standard ports above threshold port number |

---

## 9. Angular Frontend

**Framework:** Angular 17 (standalone components, lazy-loaded routes)  
**UI library:** Angular Material  
**Charts:** Chart.js via ng2-charts  
**State:** Angular Signals  
**Auth:** JWT stored in `localStorage['token']`; `AuthInterceptor` attaches as `Bearer` header

### Routes

| Path | Component | Description |
|------|-----------|-------------|
| `/dashboard` | `DashboardComponent` | Live KPIs, top apps/talkers, bandwidth chart, live flows |
| `/flows` | `FlowsComponent` | Paginated flow explorer with filters |
| `/ipdr` | `IpdrComponent` | IPDR session records |
| `/subscribers` | `SubscribersComponent` | IP→subscriber management |
| `/mappings` | `MappingsComponent` | Application classification rules |
| `/policy` | `PolicyComponent` | Per-application capture control |
| `/alerts` | `AlertsComponent` | Alert rules and event history |
| `/domains` | `DomainsComponent` | Domain/hostname resolution history |
| `/login` | `LoginComponent` | JWT login form |

### Services

**`ApiService`** — all HTTP calls, typed by endpoint. Uses `HttpParams` builder; null/empty params omitted.

**`WebSocketService`** — manages WS connection with auto-reconnect. Exposes `message$: Observable<any>` and `paused(): Signal<boolean>`. Token sourced from `localStorage`.

**`AuthService`** — login, logout, `currentUser()` signal, `isAdmin()`.

### Key helpers

**`fmtBytes(n)`** — formats raw byte counts: B / KB / MB / GB.

**`fmtApp(app, hostnames)`** — if `app` starts with `NetBIOS`, appends `{first_hostname}` from the JSON `hostnames` array.

**`isUnclassified(app)`** — returns true for raw nDPI protocol names (TLS, QUIC, HTTP, DNS, etc.) or missing category; used to power the "Show Unclassified" toggle.

### Dashboard data flow

```
ngOnInit → loadAll()
  ├── getOverview()     → updateKpis()
  ├── getTopApps()      → _topApps signal
  ├── getTopTalkers()   → topTalkers signal  (takes .sources)
  ├── getLiveFlows()    → _liveFlows signal
  ├── getBandwidth()    → bwChartData
  └── getProtocolDist() → protoChartData

WS message (live_update) → applyUpdate()
  ├── live_flows   → _liveFlows signal
  ├── top_apps     → _topApps signal + maxAppBytes
  ├── top_talkers  → topTalkers signal  (flat array, total_bytes field)
  ├── overview     → updateKpis()
  └── bandwidth    → bwChartData
```

### Dialogs

Flow detail modal opened via `MatDialog` with `panelClass: 'dark-dialog'`. Defined inline in the same file as its parent. Not opened via `window.open`.

---

## 10. Configuration

### `flow_monitor` config file (`config.json`)

```json
{
  "socket_path":           "/tmp/flow_monitor.sock",
  "interface":             "",
  "mysql_host":            "127.0.0.1",
  "mysql_port":            3306,
  "mysql_user":            "flowmon",
  "mysql_pass":            "secret",
  "mysql_db":              "flowmon",
  "mysql_socket":          "",
  "flow_timeout_seconds":  60,
  "sync_interval_seconds": 5,
  "ndpi_max_packets":      64,
  "sweep_every_packets":   1000,
  "max_active_flows":      100000,
  "rfmon":                 false
}
```

### Backend environment (`backend/.env`)

```
PORT=3000
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=flowmon
DB_PASS=secret
DB_NAME=flowmon
JWT_SECRET=change-me-to-a-long-random-secret
JWT_EXPIRES_IN=24h
WS_PUSH_INTERVAL_MS=3000
GEOIP_DB_PATH=          # optional MaxMind GeoLite2 .mmdb path
```

### Angular environments

`frontend/src/environments/environment.ts` — `apiUrl: 'http://localhost:3000/api'`

`frontend/src/environments/environment.prod.ts` — point to production API host.

---

## 11. Build & Deploy

### C++ binaries

```bash
# System-wide nDPI (sudo make install)
cmake -S . -B build
cmake --build build -j"$(nproc)"

# Local nDPI (no sudo)
git clone --depth 1 https://github.com/ntop/nDPI.git third_party/nDPI
cd third_party/nDPI && ./autogen.sh && ./configure --prefix="$PWD/../ndpi-install"
make -j"$(nproc)" && make install && cd ../..

PKG_CONFIG_PATH="$PWD/third_party/ndpi-install/lib/pkgconfig:$PKG_CONFIG_PATH" \
    cmake -S . -B build && cmake --build build -j"$(nproc)"
export LD_LIBRARY_PATH="$PWD/third_party/ndpi-install/lib:$LD_LIBRARY_PATH"
```

**nDPI 5.x required.** Not compatible with nDPI 4.x (`struct ndpi_proto` reshaped; `ndpi_detection_giveup` signature changed).

### Backend

```bash
cd backend
npm install
npm run dev       # nodemon hot-reload
npm start         # production
```

### Frontend

```bash
cd frontend
npm install
npm start         # ng serve → http://localhost:4200
npm run build     # production build
```

Angular build settings (in `angular.json`):
- Font inlining disabled (`optimization.fonts.inline: false`)
- Initial bundle budget: 2 MB warning / 5 MB error
- Component style budget: 4 KB warning / 8 KB error

### Running the full system

**Live capture mode (most common):**
```bash
sudo ./build/flow_monitor \
  --interface eth0 \
  --mysql-host 127.0.0.1 --mysql-port 3306 \
  --mysql-user flowmon --mysql-pass secret --mysql-db flowmon \
  --flow-timeout 60 --sync-interval 5 --verbose
```

**PCAP replay mode:**
```bash
# Terminal 1
./build/flow_monitor --socket /tmp/flow_monitor.sock \
  --mysql-host 127.0.0.1 --mysql-user flowmon --mysql-db flowmon --verbose

# Terminal 2
./build/pcap_processor --input traffic.pcap \
  --socket /tmp/flow_monitor.sock --batch-size 200 --verbose
```

**End-to-end smoke test:**
```bash
MYSQL_USER=flowmon MYSQL_PASS=secret ./test.sh mytraffic.pcap
```

---

## 12. Security

### Authentication

- JWT HS256, signed with `JWT_SECRET`, expires in `JWT_EXPIRES_IN` (default 24 h)
- Passwords hashed with bcrypt (cost 10)
- Login endpoint rate-limited: 20 requests / 15 minutes
- Two roles: `admin` (full access) and `viewer` (read-only)

### Authorization enforcement

| Action | Required role |
|--------|--------------|
| Read any endpoint | `viewer` or `admin` |
| Create/update/delete flows, mappings, subscribers | `admin` |
| Create/update/delete alert rules | `admin` |
| Update capture policy | `admin` |
| Create users | `admin` |

### WebSocket auth

JWT passed as `?token=<jwt>` query parameter. Invalid or expired token closes connection with code 1008.

### Network

- CORS set to `*` — restrict to frontend origin in production
- Helmet middleware with CSP disabled (required for Angular Material)
- All DB queries use parameterized statements (mysql2 `?` placeholders)

---

## 13. Constraints & Known Limitations

| Constraint | Detail |
|-----------|--------|
| **nDPI 5.x only** | `struct ndpi_proto.proto.app_protocol` nested in v5; `ndpi_detection_giveup` lost guess-flag args. Incompatible with nDPI 4.x. |
| **IPv6 CIDR mapping** | `ip_cidr` rules in `application_mappings` are IPv4 only. IPv6 flows are classified via hostname suffix/exact matching (TLS SNI). |
| **WPA2 unicast** | Encrypted at L2. `--rfmon` only decodes unencrypted 802.11 frames (open networks or gateway deployment). |
| **Generated columns** | `flows.total_packets` and `flows.total_bytes` are `GENERATED ALWAYS AS ... STORED` — never `INSERT`/`UPDATE` these columns directly. |
| **Capture policy default** | Empty `capture_policy` table = capture everything. Adding the first row switches to strict allowlist mode. |
| **Schema ownership** | `flow_monitor` is the authoritative schema owner for `flows`, `hostnames`, `urls`, `application_mappings`. Node.js creates its own tables (`users`, `alert_rules`, `alert_events`, `subscribers`, `ipdr_keys`, `protocol_metadata`, `applications_summary`, `capture_policy`) via `ensureSchema()`. Both use `IF NOT EXISTS` — safe to run in either order. |
| **`application_category` column** | Removed from `flows` table. All queries needing category must LEFT JOIN `application_mappings`. |
| **Max active flows** | Soft cap enforced by LRU eviction in C++. Default 100,000. Tune based on available RAM. |
| **Sync interval** | Default 5 s. Decrease for lower dashboard latency; increase to reduce DB write pressure on high-traffic networks. |
