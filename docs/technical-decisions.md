# Technical Decisions — FlowMon

## Decision 1: C++ for the capture layer (not Go/Python)

**Decision:** Capture daemon written in C++ with libpcap + nDPI.
**Rationale:** nDPI is a C library. Python bindings exist but add 3–5x latency per packet at high flow rates. Go's CGo overhead is similar. C++ calls nDPI in-process at full speed, handles 100k+ packets/sec on a single core. At ISP throughput, this matters.
**Trade-off:** Harder to maintain. C++ memory safety requires discipline (see nDPI `protos` union SIGSEGV risk documented in CLAUDE.md). Accepted because the alternative (Python/nDPI) would have failed our throughput requirements.

## Decision 2: Bidirectional canonical flow key

**Decision:** Flow key = `(src_ip,  dst_ip, src_port, dst_port, protocol)`.

**Rationale:** Without canonicalization, a TCP connection generates two rows (one per direction). Halving storage also halves query time for top-talker and bandwidth aggregations.
**Trade-off:** `src_ip` no longer means "the initiating side." Added `bytes_sent`/`bytes_recv` columns to preserve directionality. UI always shows `src_ip` as the "smaller" address, which is unusual but documented.

## Decision 3: MySQL `GENERATED ALWAYS AS` for total_bytes/total_packets

**Decision:** `total_bytes = bytes_sent + bytes_recv` as a stored computed column.
**Rationale:** Avoids denormalization bugs where `total_bytes` gets out of sync with its components. Every write to `bytes_sent` or `bytes_recv` automatically recalculates `total_bytes` at the DB level.
**Trade-off:** Cannot be written directly — any INSERT/UPDATE that includes `total_bytes` fails. Documented in CLAUDE.md "Things to NEVER do." Caught one bug where a route tried to insert it explicitly.

## Decision 4: Remove `application_category` column from flows

**Decision:** Removed `application_category` as a stored column. Derive at query time via LEFT JOIN `application_mappings`.
**Rationale:** The mapping was maintained in two places (the flows row and the mappings table). When an operator updated a mapping, old flows had stale categories. Join-at-query-time is always current.
**Trade-off:** Every query that needs category must include the LEFT JOIN subquery. Addressed by codifying the pattern in `nodejs-express-api.md` skill and CLAUDE.md.

## Decision 5: IPDR `last_seen` uses sweep timestamp, not packet timestamp

**Decision:** When persisting an IPDR record, `last_seen` = `now_us` (current sweep time), not the timestamp of the last packet.
**Rationale:** A flow that has been in memory for 60 s and is about to be swept has `last_packet_time` that's potentially 60 s old. Setting `last_seen = last_packet_time` would create an IPDR record that expired at the moment it was written. Using `now_us` gives the key a fresh 60 s TTL.
**Trade-off:** IPDR `last_seen` lags reality by up to `sweep_every_packets` packets. Acceptable for regulatory purposes (sessions are hours long, not seconds).

## Decision 6: WebSocket shares the HTTP port (no separate WS port)

**Decision:** WebSocket server attaches to the existing `http.Server` on port 3000. No separate WS port.
**Rationale:** One port to open in firewalls. `ws.upgrade` events on the same socket are dispatched by the `ws` library to the WS handler via the `path: '/ws'` discriminator.
**Trade-off:** The `WS_PORT` env var in `.env` is vestigial (documented as a known weirdness in CLAUDE.md). Will clean up in the next cycle.

## Decision 7: Angular standalone components (no NgModule)

**Decision:** Angular 17 standalone components with lazy-loaded routes and no NgModule.
**Rationale:** Standalone components (released stable in Angular 15) remove the boilerplate NgModule layer. Lazy loading is declarative in `app.routes.ts` without a separate routing module. Tree-shaking is more granular.
**Trade-off:** Less familiar to Angular 14-era engineers. Documented in CLAUDE.md under Architecture: frontend.

## Decision 8: JWT stored in localStorage (not HttpOnly cookie)

**Decision:** Auth token stored in `localStorage['token']`, attached via `AuthInterceptor`.
**Rationale:** Simpler implementation for a same-origin SPA. The threat model for an internal NOC dashboard (not user-facing web app) tolerates JS-accessible tokens.
**Trade-off:** Vulnerable to XSS exfiltration. For production, migrate to HttpOnly cookie + CSRF token. Documented in post-hackathon roadmap.
