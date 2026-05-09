# FlowMon — Project Plan

## What Is FlowMon

FlowMon is a three-tier ISP traffic analytics platform built to give network operators real-time visibility into flows crossing their infrastructure. It captures packets, classifies applications using deep inspection, persists session records, and surfaces analytics through a live dashboard.

---

## Architecture Overview

| Layer | Technology | Responsibility |
|-------|-----------|----------------|
| C++ capture | `pcap_processor` + `flow_monitor` | Packet capture, L2 strip, nDPI classification, MySQL persistence |
| API + WebSocket | Node.js / Express (port 3000) | REST endpoints, JWT auth, live push every 15 s |
| Dashboard | Angular 17 + Material UI | Real-time charts, flow table, alerts, policy, IPDR, subscribers |

### Data Flow

```
NIC / PCAP file
    │
    ▼
pcap_processor  ──(Unix socket, length-prefixed binary)──►  flow_monitor
                                                                  │
                                           nDPI classification    │
                                           AppMappings override   │
                                           IPDR key tracking      │
                                                                  ▼
                                                              MySQL (flowmon)
                                                                  │
                                                                  ▼
                                                        Node.js Express API
                                                                  │
                                           REST + WebSocket push  │
                                                                  ▼
                                                        Angular Dashboard
```

---

## Current Feature Set

### Capture & Classification
- Live NIC capture (libpcap) and PCAP replay
- nDPI 5.x application detection (HTTP, TLS/QUIC, DNS, 300+ protocols)
- Application mapping overrides (exact host, suffix host, exact IP, CIDR)
- Bidirectional flow tracking keyed by canonical 5-tuple
- Capture policy — per-application allow/block rules (daemon picks up within ~30 s)
- IPv4 and IPv6 support

### Persistence
- MySQL `flows` table with computed `total_bytes` / `total_packets`
- IPDR records — session-level aggregates keyed by `(src_ip, dst_ip, dst_port, application)`
- Subscriber registry with IP-to-name attribution
- Application mappings and categories

### API Surface (backend/src/index.js)
- Auth: login, me, user management
- Flows: paginated list, live (last 30 s), detail by ID
- Stats: overview KPIs, top-apps, top-talkers, bandwidth history, protocol distribution, anomalies, app-detection quality
- Alerts: rules CRUD, events list, acknowledge
- Domains: DNS query log, unique sources
- Mappings: CRUD, bulk import/export
- Subscribers: CRUD, bulk import/export
- IPDR: session list, flows-by-session
- Policy: per-application capture rules, bulk update
- Health check

### Dashboard Panels
- Overview KPIs (active flows, bytes/s, top protocol, unique IPs)
- Bandwidth Over Time (15 s polling, Chart.js line chart)
- Top Applications (doughnut + ranked list)
- Top Talkers with subscriber names
- Protocol Distribution
- Live Flow Table (WebSocket, 15 s refresh)
- Alerts (rule builder + event log + acknowledge)
- IPDR viewer
- Subscriber management
- Application Mapping manager
- Capture Policy (per-app allow/block with bulk save)

### Security
- JWT authentication on all routes except `/api/auth/login` and `/api/health`
- Admin-only write actions (policy toggle, alert rule CRUD, user create, etc.)
- Parameterised SQL throughout — no string concatenation of user input
- Structured logging via Winston (no raw `console.*`)

---

## Current Status

| Area | Status |
|------|--------|
| C++ capture + nDPI | Stable |
| MySQL schema + IPDR | Stable |
| Node.js REST API | Stable |
| WebSocket live push | Stable |
| Angular dashboard | Stable |
| GeoIP enrichment | Data in DB — UI widget not yet built |
| Capture policy daemon reload | Working (~30 s lag) |
| Alert engine | Working (30 s check interval) |
| User management UI | Admin-only, basic CRUD |
| Role-based access control | Two roles: `admin` / `viewer` |

---

## Known Issues & Deferred Work

1. **`application_category` JOIN duplication** — repeated in 5+ route files; needs a shared SQL fragment helper.
2. **`WS_PORT` env var** — declared in `.env` but unused (WS shares the HTTP port); should be removed.
3. **GeoIP UI** — GeoLite2 path wired in env but no map widget in the dashboard yet.
4. **Monitor-mode 802.11** — `--rfmon` flag exists but WPA2 unicast traffic is still encrypted at L2.
5. **Capture policy reload lag** — currently tied to `sync_active()` cycle (~30 s). Could be improved with inotify or a dedicated config socket.

---

## Technical Decisions

| Decision | Rationale |
|----------|-----------|
| Unix socket for IPC | Zero-copy, kernel-managed backpressure; avoids TCP loopback overhead for intra-host packet stream |
| nDPI 5.x only | `struct ndpi_proto` was reshaped; `ndpi_detection_giveup` API changed — 4.x compatibility would require ugly ifdefs with no upside |
| `GENERATED ALWAYS AS STORED` for byte totals | Database enforces consistency; application layer cannot accidentally double-count |
| Canonical 5-tuple key | Both directions of a flow share one row — halves DB writes and simplifies aggregation |
| IPDR key uses sweep timestamp, not packet time | Prevents immediate IPDR key re-expiry when flows finalize during a sweep |
| Angular standalone components | No NgModule boilerplate; tree-shaking per-route; lazy loading is first-class |
| Signals + `computed()` for reactive state | Replaces Zone.js change detection for fine-grained updates; avoids BehaviorSubject proliferation |

---

## Milestones

### Phase 1 — Core Platform (Done)
- [x] C++ flow capture with nDPI classification
- [x] MySQL persistence and schema auto-migration
- [x] REST API with JWT auth
- [x] Angular dashboard with live WebSocket feed
- [x] IPDR session tracking
- [x] Subscriber attribution
- [x] Capture policy engine

### Phase 2 — Operator Tooling (In Progress)
- [x] Alert rules + event log
- [x] Application mapping manager
- [x] Bulk import/export for subscribers and mappings
- [x] Admin role-based access control
- [ ] GeoIP map widget
- [ ] Scheduled reports (PDF/CSV export)
- [ ] Multi-NIC capture support

### Phase 3 — Deep Inspection & Compliance (Planned)
See `future-plan.md` for detailed roadmap.

---

## Build & Run Reference

```bash
# C++ (live capture)
sudo ./build/flow_monitor --interface eth0 \
  --mysql-host 127.0.0.1 --mysql-user flowmon --mysql-pass '<pass>' --mysql-db flowmon

# Backend
cd backend && npm start

# Frontend
cd frontend && npm start   # → http://localhost:4200
```

Default credentials: `admin / admin123` (change immediately in production).
