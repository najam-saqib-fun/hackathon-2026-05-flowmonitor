# FlowMon — Project Specification

## Problem

ISPs and network operators have no affordable, self-hosted tool to monitor traffic in real time, classify applications, and produce regulatory-grade IPDR session records. Existing solutions are either proprietary appliances or raw packet dumps with no analytics layer.

## Solution

FlowMon is a three-tier open-source ISP traffic analytics platform:

1. **C++ capture daemon** (`flow_monitor`) — taps a live NIC or replays PCAPs, runs nDPI deep-packet inspection, aggregates bidirectional flows, and persists them to MySQL.
2. **Node.js API** — Express REST + WebSocket server; exposes all flow data, stats, and controls to the UI and external consumers.
3. **Angular dashboard** — real-time operator UI with live charts, flow explorer, subscriber management, IPDR records, alerting, and capture policy.

## Core Features

| Feature | Description |
|---------|-------------|
| Live packet capture | Direct NIC tap (libpcap) or PCAP replay; IPv4 + IPv6 |
| Application detection | nDPI 5.x DPI + operator-defined hostname/IP/CIDR override rules |
| Real-time dashboard | WebSocket push every 15 s — KPIs, top apps, top talkers, live flows |
| Flow Explorer | Paginated, filterable table of all flows with subscriber attribution |
| IPDR tracking | Session-level records `(src_ip, dst_ip, dst_port, app)` for regulatory audit |
| Subscriber management | Map IP addresses to customer IDs; shown throughout the UI |
| Capture policy | Per-application allowlist; C++ daemon reloads it every sync cycle |
| Alerting | Threshold rules (bytes/sec, flows/min, conn/IP, unusual port) with WS broadcast |
| Domain history | TLS SNI / DNS hostname resolution log per flow |
| App mappings | Operator-editable hostname-suffix, exact-IP, CIDR rules with CSV/JSON import |

## Technology Stack

| Layer | Technologies |
|-------|-------------|
| Capture | C++17, libpcap, nDPI 5.x, MySQL C API |
| API | Node.js 20, Express 4, ws, mysql2, bcryptjs, jsonwebtoken |
| Frontend | Angular 17 (standalone), Angular Material, Chart.js, ng2-charts |
| Database | MySQL 8 / MariaDB 10.6+ |

## Architecture

```
[NIC / PCAP] → flow_monitor (C++) → MySQL ← Node.js API ← Angular UI
                                              ↕ WebSocket (15 s push)
```

## Key Design Decisions

- **Canonical flow key**: `min(src_ip, dst_ip)` first so both directions share one row — halves storage and simplifies aggregation.
- **nDPI safety**: TLS metadata fields only read when `proto_is_tls_family()` — the `protos` union aliases bytes across protocols causing SIGSEGV otherwise.
- **`application_category` removed from `flows`**: derived at query time via `LEFT JOIN application_mappings` to avoid schema drift.
- **IPDR `last_seen` uses sweep timestamp** (`now_us`), not packet time — prevents keys from expiring immediately after creation.
- **Capture policy default**: empty `capture_policy` table = capture everything; first row switches to strict allowlist mode.

## Non-Goals

- Encrypted WPA2 unicast decryption
- IPv6 CIDR application mapping (SNI matching covers most IPv6 traffic)
- Multi-node distributed capture (single-node only)

## Deployment

```bash
# C++ daemon (live capture)
sudo ./build/flow_monitor --interface eth0 --mysql-host 127.0.0.1 \
  --mysql-user flowmon --mysql-pass secret --mysql-db flowmon

# API
cd backend && npm start

# UI
cd frontend && npm start   # dev
```

Default credentials: `admin` / `admin123` — change before production.
