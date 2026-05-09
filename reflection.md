# Project Reflection — FlowMon

**Author:** najam-ul-saqib
**Date:** 2026-05-07

---

## What We Built

A three-tier ISP traffic analytics platform: a C++ capture daemon (libpcap + nDPI 5.x) writing bidirectional flows to MySQL, a Node.js REST + WebSocket API, and an Angular 17 real-time dashboard. Twelve features shipped: live capture, app detection, flow explorer, IPDR session tracking, subscriber management, capture policy, alerting, domain history, mappings, and IPv6 support.

---

## What Went Well

**C++ + SQL architecture held up.** Separating the packet-processing concern (C++) from the serving concern (Node.js) paid off early. The two tiers share only the MySQL schema — no shared process state — making each independently debuggable.

**nDPI made application detection trivial.** Without it, classifying YouTube vs. Netflix vs. DNS would have required hundreds of manually maintained rules. nDPI 5.x classified 90%+ of flows on the first PCAP replay.

**WebSocket decoupling worked well.** Removing bandwidth data from the WS push and giving it its own `setInterval` in the frontend was the right call. Each data type now has the right refresh frequency without coupling them.

**Claude Code accelerated the build significantly.** Bundling multiple symptoms in one prompt (rather than one fix per session) produced faster root-cause analysis. Providing concrete before/after data numbers turned ambiguous "values change" bugs into one-pass fixes.

---

## What Was Harder Than Expected

**The `protos` union SIGSEGV.** Reading `protos.tls_quic.client_requested_server_name` on a DNS flow crashes because the union aliases DNS counter integers to the TLS `char*` pointer. The guard (`proto_is_tls_family()`) was obvious in hindsight but took a full debug session to find.

**WS/REST data consistency.** The WebSocket queries were written for "recent activity" while the REST endpoints returned all-time totals. The numbers appeared correct until a page refresh — then they dropped. Root cause required DB verification with explicit `COUNT(*)` queries to confirm which window was wrong.

**`application_category` column removal.** Dropping a column that was referenced in five separate route files created a cascade of silent failures — queries returned empty categories rather than errors. The fix (LEFT JOIN subquery everywhere) was mechanical but tedious to apply consistently.

---

## What I Would Do Differently

1. **Define the DB schema contract first.** If `application_category` removal had been captured in a schema changelog before writing the routes, the cascade of JOIN fixes wouldn't have been needed.

2. **Write WS and REST queries side-by-side.** The scope mismatch was a natural consequence of writing them at different times. A shared query module with named scopes (`allTime()`, `lastHour()`) would prevent the divergence.

3. **Automated smoke test earlier.** `test.sh` was written late. Running it from the first PCAP replay would have caught the IPv6 packet-drop bug (91% of traffic missed) in the first session instead of the third.

---

## Key Technical Learnings

- **nDPI's `protos` is a C union** — reading any protocol-specific field without checking the active protocol causes SIGSEGV. Always guard with `proto_is_tls_family()`, `ndpi_is_quic_protocol()`, etc.
- **IPDR `last_seen` must use sweep time, not packet time.** A flow that has already expired sets `last_seen` in the past — the IPDR key expires immediately on creation unless you use `now_us` instead.
- **MySQL generated columns (`GENERATED ALWAYS AS ... STORED`) cannot be written.** Any INSERT/UPDATE that includes `total_bytes` or `total_packets` fails silently in some MySQL modes.
- **Module-level constants must precede `@Component` in Angular.** TypeScript requires the decorator to immediately precede the class declaration; inserting anything between them breaks compilation (`TS1206`).

---

## One Sentence

FlowMon proved that a self-hosted, regulatory-grade ISP analytics stack is achievable in a single sprint when C++/SQL/Angular are kept in separate tiers and each tier is given exactly one responsibility.
