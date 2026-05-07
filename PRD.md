# FlowMon — Product Requirements Document

## Overview

FlowMon is a three-tier ISP traffic analytics platform:
- **C++ layer** — `flow_monitor` captures packets, runs nDPI app detection, persists to MySQL
- **Node.js backend** — Express REST API + WebSocket server (port 3000)
- **Angular frontend** — Material UI dashboard with real-time live feed

---

## Features Delivered

---

### 1. Live Packet Capture & Flow Aggregation

**What it does:** `flow_monitor` captures packets from a live NIC or PCAP file, aggregates them into bidirectional flows keyed by canonical 5-tuple (src_ip, dst_ip, src_port, dst_port, protocol), and persists to MySQL.

**Key details:**
- nDPI 5.x for deep packet inspection and application detection
- Canonical flow key: smaller IP first (ties broken by port) so both directions share one row
- `flow_timeout_seconds` (default 60 s) — idle flows expire and are finalized
- `sync_interval_seconds` — live flows upserted to DB for real-time visibility
- Max active flows cap with LRU eviction (`max_active_flows`)

**Bugs fixed during development:**
- **SIGSEGV on first packet** — `capture_extracted()` was reading `protos.tls_quic` union fields (char\* pointers) on non-TLS flows. nDPI's `protos` is a C union; on DNS flows those bytes alias to DNS counter integers, producing garbage pointers. Fix: `proto_is_tls_family()` guard; only read `tls_quic` fields when protocol is TLS/QUIC/DTLS/FTPS.

---

### 2. Application Detection & Mapping

**What it does:** nDPI classifies each flow to an application name (e.g. "TLS", "YouTube", "DNS"). Application mappings let operators override or refine classification via hostname/IP/CIDR rules.

**Mapping types:**
- `hostname_suffix` — matches host and all subdomains (e.g. `googlevideo.com` → YouTube)
- `hostname_exact` — exact SNI/DNS match
- `ip_exact` — exact IPv4 address
- `ip_cidr` — IPv4 CIDR range

**UI:** Application Mappings page with add/edit/delete, bulk CSV/JSON import, export, pagination, and search.

**Bugs fixed:**
- `application_category` column was dropped from `flows` table in a migration. All backend queries that referenced it directly were rewritten to use a LEFT JOIN subquery: `(SELECT application, MIN(category) AS category FROM application_mappings GROUP BY application) am ON am.application = f.application`.

---

### 3. Real-Time Dashboard

**What it does:** WebSocket push every 3 s (configurable via `WS_PUSH_INTERVAL_MS`) delivers:
- **Live flows** — active flows updated in the last 30 s
- **Overview KPIs** — total flows, bytes, packets, unique IPs, unique apps
- **Top apps** — by bytes in last 5 min
- **Top talkers** — by bytes in last 5 min

**Auth:** JWT via `?token=<jwt>` query param on WebSocket connect.

---

### 4. Flow Explorer

**What it does:** Searchable, paginated table of all flows with filters: source IP, destination IP, application, subscriber ID, protocol, time range. Clicking a row opens a JSON detail modal.

**Columns:** Source (IP:port + subscriber), Destination, Protocol badge, Application, Total Bytes, Duration, Start Time.

**Toggle:** Show/hide unclassified flows (dim opacity for raw protocol names).

---

### 5. Subscriber Management

**What it does:** Map IP addresses to subscriber IDs and names. Flow Explorer and IPDR reports use this to show who generated each flow.

**UI:** Add/edit/delete subscribers, bulk import CSV/JSON, export.

---

### 6. IPDR (IP Detail Record) Tracking

**What it does:** Groups flows by session key `(src_ip, dst_ip, dst_port, application)` into long-lived IPDR records for regulatory/audit use. An IPDR record stays open while new flows arrive; it closes after `flow_timeout_seconds` of inactivity.

**Bugs fixed:**
- **IPDR keys closing immediately after creation** — `assign_ipdr_key` was setting `last_seen_us = f.last_packet_time_us`. Since the flow had already expired (≥60 s idle), the subsequent IPDR sweep immediately closed the new key. Fix: use `now_us` (sweep timestamp) for `last_seen_us`.
- **`first_seen > last_seen` in IPDR records** — non-deterministic `unordered_map` iteration caused a later-starting flow to create the key, then an earlier-ending flow to overwrite `last_seen` backward. Fix: `ipdr_update` uses `LEAST(first_seen, ...)` and `GREATEST(last_seen, ...)`.

---

### 7. `applications_summary` Table

**What it does:** Aggregates per-application totals (flows, bytes sent/recv, packets, duration, first/last seen) for the Top Apps chart and Policy page. Much faster than scanning the `flows` table.

**Bug fixed:**
- **Double-counting bytes** — `persist_flow_id()` was called from both `sync_active()` (every 30 s, cumulative bytes) and `finalize_and_persist()` (on expiry), causing each sync cycle to add the current cumulative byte count again. Fix: removed summary update from `persist_flow_id()`; added separate `update_app_summary()` called only from `finalize_and_persist()`.

---

### 8. Alert Rules & Events

**What it does:** Operators define threshold rules evaluated every 30 s by the WebSocket server. When triggered, an `alert_event` is inserted and all connected WS clients receive a `{type:'alert'}` push.

**Metrics supported:**
- `bytes_per_sec` — bandwidth threshold (optionally filtered by application or src_ip)
- `flows_per_min` — new flow rate
- `conn_per_ip` — max connections from a single source IP

**UI:** Alert Rules page to create/edit/delete rules; Alert Events page with acknowledge button.

---

### 9. Domain / Hostname Tracking

**What it does:** DNS hostnames and TLS SNIs extracted by `flow_monitor` are stored in the `hostnames` table linked to their parent flow. The Domains page shows resolution history, source IPs, subscriber IDs, and top domains by occurrence.

---

### 10. Capture Policy (Allowlist)

**What it does:** Operators control which applications `flow_monitor` persists to the database. When the `capture_policy` table has any rows, the binary operates in allowlist mode — only applications with `enabled=1` are saved. An empty table means capture everything (safe default).

**UI — Policy Page features:**
- Table of all known applications (from `applications_summary` + `capture_policy`) with per-row slide toggle
- **Enable All / Disable All** bulk action buttons
- **Search** field to filter by application name
- **Category** dropdown filter
- **Add / Override Rule** card — type any application name (autocomplete from `application_mappings`), click **Allow** or **Block** to save immediately to the database
- Sticky Save bar for batch toggle changes; Revert button to undo unsaved changes
- Summary chips showing enabled/disabled/unsaved counts

**C++ behavior:**
- `reload_policy()` runs inside every `sync_active()` cycle (~30 s) — UI changes take effect without restarting the daemon
- Empty `capture_policy` table → `policy_active_ = false` → capture everything
- Non-empty table → `policy_active_ = true` → only persist flows whose `f.application` is in `allowed_apps_`

**Backend endpoints:**
- `GET /api/policy` — lists all apps (UNION of `applications_summary` + `capture_policy`-only entries)
- `PUT /api/policy/:application` — upsert a single rule
- `POST /api/policy/bulk` — batch upsert `{ updates: [{application, enabled}] }`
- `GET /api/mappings/applications?q=` — autocomplete, returns distinct app names matching query

---

### 11. Angular Frontend Build Fixes

- Font inlining disabled (`optimization.fonts.inline: false`) to avoid network errors during CI builds
- Initial bundle budget raised to 2 MB warning / 5 MB error
- Component style budget raised to 4 KB warning / 8 KB error

---

## Database Schema (key tables)

| Table | Purpose |
|-------|---------|
| `flows` | One row per bidirectional flow (5-tuple + start_time_us) |
| `hostnames` | DNS/SNI hostnames extracted from flows |
| `applications_summary` | Aggregated per-application statistics |
| `application_mappings` | Operator-defined hostname/IP → application rules |
| `ipdr_keys` | Long-lived IPDR session records |
| `subscribers` | IP → subscriber ID/name mapping |
| `alert_rules` | Threshold rules evaluated every 30 s |
| `alert_events` | Triggered alert history |
| `capture_policy` | Per-application allowlist (empty = capture all) |
| `users` | Auth users (admin seeded on first run) |

---

### 12. IPv6 Support

**What it does:** Both `pcap_processor` and `flow_monitor` now parse IPv4 and IPv6 packets. YouTube streaming traffic (QUIC/UDP over IPv6 to Google's `2a00:1450:4019::/32`) is fully captured.

**Technical changes:**
- `PacketMessage` struct in `common.h` changed from `uint32_t src_ip/dst_ip` to `uint8_t src_ip[16]/dst_ip[16]` plus `uint8_t ip_version`. Struct size: 25 → 50 bytes.
- `pcap_processor`: `l3_offset()` now accepts both `ETHERTYPE_IP` (0x0800) and `ETHERTYPE_IPV6` (0x86DD). Main loop peeks at the IP version nibble and uses `ip6_hdr` for IPv6 frames; walks extension headers (HopByHop, Routing, Destination) to reach the transport layer.
- `flow_monitor`: `live_l3_offset()` and `live_parse_packet()` updated identically. `ip_bytes_to_str(bytes, version)` replaces `ipv4_to_str()`. Direction detection uses `memcmp` on 16-byte arrays. CIDR lookup gated to IPv4 flows only.

**Bugs fixed:**
- **IPDR keys closing during long YouTube sessions** — `sync_active()` now refreshes `ipdr_keys_[lk].last_seen_us = now_us` for every active flow on each sync cycle. Previously the key's timestamp was only updated when a flow *expired*, so a continuously active flow never bumped it and the key closed after 60 s of no *finalizations*.

**Result:** Before: `mytraffic.pcap` (3527 packets, 91% IPv6) → only ~309 sent. After: **3525 sent**. `mytraffic1.pcap` (13852 packets, 85% IPv6): **13846 sent**.

---

## Known Constraints

- nDPI **5.x only** — `struct ndpi_proto` was reshaped in v5; not compatible with nDPI 4.x
- WPA2 unicast traffic is encrypted at L2; `--rfmon` mode only decodes unencrypted 802.11 frames
- `total_packets` and `total_bytes` in `flows` are MySQL `GENERATED ALWAYS AS ... STORED` columns — never write to them directly
- `capture_policy` empty = capture all; adding the first row switches to strict allowlist mode
- IPv6 CIDR-based application mapping not yet supported — only hostname suffix and exact-IP lookups work for IPv6 flows. YouTube is identified via TLS SNI (`googlevideo.com`) extracted by nDPI.
