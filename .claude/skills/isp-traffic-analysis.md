---
name: ISP Traffic Analysis
description: Domain knowledge for ISP flow data — bidirectional flows, IPDR semantics, subscriber attribution, nDPI quirks, and common SQL patterns
type: project
---

# Skill: ISP Traffic Analysis

When working on ISP traffic analytics systems, apply the following domain knowledge.

## Flow Data Fundamentals

- **Bidirectional flows**: Both directions of a conversation share one row keyed by canonical 5-tuple (`min(src_ip, dst_ip)` first). Never aggregate bytes by direction without checking which side is source.
- **`total_bytes` is computed**: In MySQL schemas that use `GENERATED ALWAYS AS (bytes_sent + bytes_recv) STORED`, never INSERT/UPDATE this column directly.
- **`application_category` vs JOIN**: If a schema has removed `application_category` as a column from the flows table, always derive it at query time: `LEFT JOIN (SELECT application, MIN(category) AS category FROM application_mappings GROUP BY application) am ON am.application = f.application`.

## IPDR (IP Detail Records)

- IPDR key = `(src_ip, dst_ip, dst_port, application)` — represents a session across multiple flows.
- `last_seen` must use the **sweep timestamp** (`now`), not the last packet time. If the flow has already expired before the IPDR record is written, using packet time causes immediate re-expiry of the IPDR key.
- Use `LEAST(first_seen, new_value)` and `GREATEST(last_seen, new_value)` when merging IPDR records to stay monotonic.

## Dashboard Data Consistency

- REST endpoints and WebSocket push must query the **same time scope**. A common bug: REST queries all-time, WS queries last N minutes → numbers drop after first refresh.
- `Flows (60s)` / `Bytes (60s)` KPIs should always use `updated_at >= NOW() - INTERVAL 60 SECOND` (active flows), not `start_time`.
- For "Top Applications" in a dashboard: prefer `applications_summary` table (pre-aggregated all-time) over querying `flows` with a recent window — it's faster and consistent with all-time KPIs.

## nDPI Integration (C++)

- nDPI 5.x only: `struct ndpi_proto` has `proto.app_protocol` nested; `ndpi_detection_giveup` takes no guess-flag args.
- **SIGSEGV risk**: only read `protos.tls_quic.*` fields when `proto_is_tls_family()` is true. The `protos` union aliases bytes — DNS flows alias TLS `char*` pointers to DNS counter integers.
- Feed nDPI from the **IP header**, not L2: `ndpi_detection_process_packet(ctx, ndpi_flow, pkt + ip_offset, pkt_len - ip_offset, ts, src, dst)`.

## Subscriber Attribution

- Join flows to subscribers on `src_ip = ip_address` (subscribers table).
- Always `COALESCE(s.subscriber_id, 'unknown')` — unannotated IPs are common and the UI should handle them gracefully.
- Top Talkers queries need the subscriber JOIN to be useful for ISP operators: `LEFT JOIN subscribers s ON s.ip_address = f.src_ip`.

## Capture Policy

- Empty `capture_policy` table = capture everything (safe default). A single row switches to strict allowlist mode.
- The C++ daemon reloads policy inside every `sync_active()` call — UI changes take effect within one sync interval (~30 s), no restart needed.

## Common Query Patterns

```sql
-- Category for a flow (application_category column removed)
LEFT JOIN (
  SELECT application, MIN(category) AS category
  FROM application_mappings GROUP BY application
) am ON am.application = f.application

-- Active flows KPI (last 60 seconds)
SELECT COUNT(*) FROM flows WHERE updated_at >= NOW() - INTERVAL 60 SECOND

-- Top talkers with subscriber names
SELECT f.src_ip, SUM(f.total_bytes) AS total_bytes,
       COALESCE(s.subscriber_id, 'unknown') AS subscriber_id
FROM flows f
LEFT JOIN subscribers s ON s.ip_address = f.src_ip
GROUP BY f.src_ip, s.subscriber_id
ORDER BY total_bytes DESC
```
