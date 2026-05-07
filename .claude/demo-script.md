# Demo Script — FlowMon

**Audience:** Judges / technical evaluators
**Duration:** 8–10 minutes
**Format:** Live system with PCAP replay running in background

---

## Pre-Demo Checklist

- [ ] MySQL running: `sudo systemctl start mysql`
- [ ] Backend running: `cd backend && npm start`
- [ ] Frontend running: `cd frontend && npm start` → http://localhost:4200
- [ ] C++ binary capturing or replaying:
  ```bash
  # Live capture
  sudo ./build/flow_monitor --interface eth0 \
    --mysql-host 127.0.0.1 --mysql-user flowmon --mysql-pass '<pass>' \
    --mysql-db flowmon --verbose

  # Or PCAP replay
  ./build/flow_monitor --socket /tmp/flow.sock \
    --mysql-host 127.0.0.1 --mysql-user flowmon --mysql-pass '<pass>' --mysql-db flowmon
  ./build/pcap_processor --input mytraffic.pcap --socket /tmp/flow.sock --verbose
  ```
- [ ] At least 5 000 flows in DB for meaningful charts
- [ ] Browser on Dashboard page, logged in as `admin`

---

## Script

### 0:00 — Problem (60 s)

> "ISPs have no affordable, self-hosted tool to monitor traffic in real time, classify applications by name, and generate regulatory-grade session records. Existing options are vendor appliances at $50 k+ or raw packet dumps with no analytics."

> "FlowMon is a three-tier open-source platform that runs on any Linux box with a NIC."

---

### 1:00 — Architecture (60 s)

Point to the three tiers:

> "A C++ daemon taps the NIC using libpcap, runs nDPI deep-packet inspection to identify the application — YouTube, Netflix, DNS, TLS — and writes bidirectional flows to MySQL. A Node.js API serves the data over REST and WebSocket. An Angular dashboard shows everything in real time."

Show the terminal with `flow_monitor --verbose` output scrolling.

---

### 2:00 — Dashboard (2 min)

Navigate to Dashboard.

1. **KPI row** — point to Total Flows, Total Bytes, Unique IPs, Unique Apps.
   > "These are all-time counts. Flows and Bytes in the last 60 seconds are shown separately — useful for spotting traffic spikes."

2. **Top Applications chart** — hover over bars.
   > "Powered by the `applications_summary` pre-aggregated table — sub-millisecond query even on millions of rows."

3. **Top Talkers** — point to subscriber names.
   > "Flows are joined to the Subscribers table so operators see customer IDs, not just IP addresses."

4. **Bandwidth Over Time** — let the chart tick over once.
   > "This polls the REST API every 15 seconds independently of the WebSocket push."

5. **Protocol Distribution** doughnut.
   > "nDPI classifies down to the application layer — TLS, QUIC, HTTP/2 — not just port 443."

---

### 4:00 — Flow Explorer (90 s)

Navigate to Flow Explorer.

1. Filter by application → type "YouTube".
2. Click a row → show JSON modal with SNI hostname, bytes sent/recv, duration.
   > "The canonical flow key deduplicates both directions into one row. SNI hostnames extracted by nDPI are stored alongside."

3. Toggle "Hide unclassified" — rows dim.

---

### 5:30 — IPDR Records (60 s)

Navigate to IPDR.

> "IPDR — IP Detail Records — are long-lived session records keyed by source IP, destination IP, destination port, and application. These are what regulators require for lawful intercept audit trails."

Show a record with `first_seen` / `last_seen` spread over minutes.

> "The session stays open as long as new flows arrive. It closes only after 60 seconds of silence on that key."

---

### 6:30 — Capture Policy (60 s)

Navigate to Policy.

> "Operators control exactly which applications are written to the database. Empty policy = capture everything. Add one row and it switches to strict allowlist mode."

Toggle an application off and back on.

> "The C++ daemon reloads policy every 30 seconds without a restart."

---

### 7:30 — Application Mappings (45 s)

Navigate to Mappings.

> "nDPI classifies by protocol. Operators can override or enrich that with hostname suffix, exact IP, or CIDR rules. This is how 'TLS' becomes 'Netflix' or 'Zoom'."

Show the bulk import button.

---

### 8:15 — Alert Rules (45 s)

Navigate to Alert Rules.

> "Threshold rules evaluated every 30 seconds by the WebSocket server. When triggered, the operator gets a live push notification without polling."

---

### 9:00 — Close

> "FlowMon is fully open-source. Runs on a $40 SBC, no vendor lock-in, no cloud dependency. The C++ layer handles IPv4 and IPv6. The entire stack — capture, API, UI — deploys with three commands."

---

## Likely Questions

| Question | Answer |
|----------|--------|
| How does it handle encrypted traffic? | TLS SNI is extracted before the handshake completes — hostname is visible. Payload content is not decrypted. |
| How many flows per second can it handle? | nDPI processes at wire speed; MySQL is the bottleneck. Tested up to ~5 000 flows/min on a laptop. |
| Is this production-ready? | Core capture and API are stable. Auth is JWT-only (no RBAC yet). Suitable for lab/small-ISP deployment. |
| IPv6? | Full IPv6 support added — `common.h` uses 16-byte address arrays; all three tiers handle IPv4 and IPv6. |
| How does IPDR differ from flows? | Flows are per-connection (5-tuple + start time). IPDR aggregates multiple flows for the same session key over time — one record per "conversation". |
