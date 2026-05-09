# FlowMon — Architecture Overview

## System Layers

```
┌─────────────────────────────────────────────────────────────────────┐
│                        CAPTURE LAYER  (C++)                         │
│                                                                     │
│  ┌──────────────────────┐        ┌──────────────────────────────┐  │
│  │    pcap_processor     │        │        flow_monitor          │  │
│  │                      │        │                              │  │
│  │  • libpcap / live NIC│──────▶│  • Bidirectional flow table  │  │
│  │  • PCAP file replay  │  Unix  │  • nDPI 5.x classification   │  │
│  │  • L2 strip          │ socket │  • AppMappings overrides     │  │
│  │  • PacketMessage     │ stream │  • IPDR key tracking         │  │
│  │    (50-byte header)  │        │  • Capture policy engine     │  │
│  └──────────────────────┘        │  • MySQL persistence         │  │
│                                  └──────────────┬───────────────┘  │
└─────────────────────────────────────────────────┼───────────────────┘
                                                  │ mysql2
                                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        DATA LAYER  (MySQL)                          │
│                                                                     │
│   flows          ipdr_sessions     subscribers    capture_policy    │
│   application_   alerts_rules      alert_events   application_      │
│   mappings       domains           users          mappings          │
└─────────────────────────────────────────────────┬───────────────────┘
                                                  │ mysql2 pool
                                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        API LAYER  (Node.js / Express :3000)         │
│                                                                     │
│  ┌────────────────────────────────┐  ┌───────────────────────────┐ │
│  │       REST API (HTTP)          │  │    WebSocket Server        │ │
│  │                                │  │                           │ │
│  │  /api/auth/*    /api/flows/*   │  │  JWT auth via ?token=     │ │
│  │  /api/stats/*   /api/alerts/*  │  │  Push every 15 s:         │ │
│  │  /api/ipdr/*    /api/policy/*  │  │  • live_flows             │ │
│  │  /api/domains/* /api/mappings/*│  │  • overview KPIs          │ │
│  │  /api/subscribers/*            │  │  • top_apps               │ │
│  │                                │  │  • top_talkers            │ │
│  │  Auth: JWT Bearer              │  │  Alert check every 30 s   │ │
│  └────────────────────────────────┘  └───────────────────────────┘ │
└─────────────────────────────────────────────────┬───────────────────┘
                                                  │ HTTP + WS
                                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      DASHBOARD LAYER  (Angular 17 :4200)            │
│                                                                     │
│  ┌──────────┐ ┌───────┐ ┌─────────┐ ┌────────┐ ┌───────────────┐  │
│  │Dashboard │ │ Flows │ │ Alerts  │ │  IPDR  │ │   Policy      │  │
│  │          │ │       │ │         │ │        │ │               │  │
│  │KPI cards │ │Table  │ │Rule CRUD│ │Sessions│ │Allow / Block  │  │
│  │BW chart  │ │Filter │ │Event log│ │Flow    │ │per-app toggle │  │
│  │Top apps  │ │Detail │ │Ack      │ │drill-in│ │Bulk save      │  │
│  │Top tlkrs │ │modal  │ │         │ │        │ │               │  │
│  └──────────┘ └───────┘ └─────────┘ └────────┘ └───────────────┘  │
│                                                                     │
│  ┌──────────────┐ ┌─────────────┐ ┌──────────────┐                 │
│  │  Subscribers │ │  Mappings   │ │   Domains    │                 │
│  │  IP registry │ │  App rules  │ │  DNS log     │                 │
│  │  Import/exp. │ │  CIDR/host  │ │  Unique srcs │                 │
│  └──────────────┘ └─────────────┘ └──────────────┘                 │
│                                                                     │
│  State: Angular Signals + computed()   Auth: JWT in localStorage    │
│  Live:  WebSocket (15 s push)          Charts: Chart.js / ng2-charts│
└─────────────────────────────────────────────────────────────────────┘
```

---

## Data Flow

```
Network traffic (NIC / PCAP)
        │
        ▼
  pcap_processor
  ├─ strips L2 header
  ├─ reads L3 packet
  └─ sends PacketMessage over Unix socket
        │
        │  [uint32 len][50-byte header: ts, src_ip, dst_ip, ports, proto][payload]
        ▼
  flow_monitor
  ├─ lookup_or_create(5-tuple canonical key)
  ├─ run_ndpi(packet) → app protocol
  ├─ apply_mapping_override() → override application name
  ├─ sweep_expired() every 1000 pkts → finalize idle flows → IPDR update
  └─ sync_active() every 30 s → upsert live flows + refresh IPDR timestamps
        │
        ▼
     MySQL
        │
        ├─ REST poll (on demand)
        └─ WebSocket push (every 15 s)
              │
              ▼
        Angular Dashboard
```

---

## Component Interaction

```
┌─────────────────────────────────────────────────────────┐
│  Angular Component                                      │
│                                                         │
│  ApiService ──────────────── HTTP GET /api/stats/...    │
│                                     │                   │
│  WebSocketService ◄── push ── WS /ws?token=<jwt>        │
│        │                            │                   │
│  signal<T>()                   AuthInterceptor          │
│  computed()                    adds Bearer header       │
│        │                                                │
│  template [dataSource]="filteredRows()"                 │
└─────────────────────────────────────────────────────────┘
```

---

## IPC Wire Format

```
┌──────────────┬──────────────────────────────────────────────────────┐
│ uint32 (4B)  │                  PacketMessage (50B)                  │
│  body_len    ├──────────┬──────────┬──────────┬──────┬──────┬───────┤
│              │timestamp │ src_ip   │ dst_ip   │ports │proto │payload│
│              │  8 bytes │ 16 bytes │ 16 bytes │ 4B   │ 2B   │  len  │
└──────────────┴──────────┴──────────┴──────────┴──────┴──────┴───────┘
  EOF sentinel: body_len = 0
```

---

## Technology Stack

| Layer | Technology | Key Libraries |
|-------|-----------|---------------|
| Capture | C++17 | libpcap, nDPI 5.x, libmysqlclient |
| Database | MySQL 8 | — |
| API | Node.js 20 + Express 4 | mysql2, jsonwebtoken, ws, winston |
| Dashboard | Angular 17 | Angular Material, Chart.js, ng2-charts |

---

## Security Boundary

```
Public internet / LAN
        │
        ▼
   [ NIC / PCAP ]
        │  (raw packets — no auth)
        ▼
   flow_monitor  (local process, runs as root for pcap)
        │  (mysql2 — DB credentials in env)
        ▼
     MySQL  (localhost only)
        │  (JWT required on all routes)
        ▼
   Express API  :3000
        │  (Bearer token checked by AuthInterceptor)
        ▼
   Angular Dashboard  :4200
   └─ Admin role: write actions (policy, alerts, users)
   └─ Viewer role: read-only
```
