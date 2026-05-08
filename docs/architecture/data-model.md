# Data Model — FlowMon

## Core tables

### `flows`

Primary table. One row per bidirectional flow (canonical 5-tuple + start time).

| Column | Type | Notes |
|--------|------|-------|
| `id` | BIGINT PK AUTO | |
| `flow_hash` | CHAR(32) UNIQUE | MD5(canonical_5tuple + "_" + start_time_us) |
| `src_ip` | VARCHAR(45) | Always the "smaller" IP of the pair |
| `dst_ip` | VARCHAR(45) | Always the "larger" IP of the pair |
| `src_port` | SMALLINT UNSIGNED | |
| `dst_port` | SMALLINT UNSIGNED | |
| `protocol` | TINYINT UNSIGNED | 6=TCP 17=UDP 1=ICMP |
| `application` | VARCHAR(64) | nDPI result or mapping override |
| `bytes_sent` | BIGINT | Direction from src_ip |
| `bytes_recv` | BIGINT | Direction from dst_ip |
| `total_bytes` | BIGINT GENERATED | `bytes_sent + bytes_recv` (STORED) |
| `packets_sent` | BIGINT | |
| `packets_recv` | BIGINT | |
| `total_packets` | BIGINT GENERATED | `packets_sent + packets_recv` (STORED) |
| `start_time` | DATETIME(6) | Microsecond precision |
| `end_time` | DATETIME(6) | |
| `updated_at` | DATETIME(6) | Updated on every sync_active() call |
| `flow_duration_ms` | BIGINT GENERATED | `TIMESTAMPDIFF(MICROSECOND, start_time, end_time) / 1000` |
| `hostnames` | JSON | DNS / TLS SNI hostnames seen |
| `urls` | JSON | HTTP URLs seen (partial) |
| `is_active` | TINYINT(1) | 1 while in memory, 0 after expiry |
| `ip_version` | TINYINT | 4 or 6 |

**Invariants:**
- `flow_hash` is unique — same 5-tuple after expiry creates a new row (different `start_time_us` → different hash).
- Never write `total_bytes` or `total_packets` directly.
- `application_category` column was removed — derive at query time via LEFT JOIN `application_mappings`.

### `application_mappings`

Operator-defined rules that override nDPI classification.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INT PK AUTO | |
| `application` | VARCHAR(64) | Canonical app name to assign |
| `category` | VARCHAR(64) | Display category |
| `pattern_type` | ENUM | `exact_host`, `suffix_host`, `exact_ip`, `cidr` |
| `pattern_value` | VARCHAR(255) | Hostname, IP, or CIDR string |

CIDR lookups only for IPv4. IPv6 SNI matching covers most IPv6 traffic.

### `subscribers`

IP-to-customer mapping for operator attribution.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INT PK AUTO | |
| `ip_address` | VARCHAR(45) | Exact match only |
| `subscriber_id` | VARCHAR(64) | Customer identifier |
| `name` | VARCHAR(128) | Display name |
| `notes` | TEXT | Operator notes |

Joined to `flows` on `src_ip = ip_address`. `COALESCE(s.subscriber_id, 'unknown')` where no match.

### `ipdr_records`

Session-level records for regulatory compliance.

| Column | Type | Notes |
|--------|------|-------|
| `id` | BIGINT PK AUTO | |
| `src_ip` | VARCHAR(45) | |
| `dst_ip` | VARCHAR(45) | |
| `dst_port` | SMALLINT | |
| `application` | VARCHAR(64) | |
| `first_seen` | DATETIME(6) | `LEAST(existing, new)` on upsert |
| `last_seen` | DATETIME(6) | `GREATEST(existing, new)` on upsert |
| `total_bytes` | BIGINT | Accumulated across all flows for this key |
| `flow_count` | INT | |

**IPDR key** = `(src_ip, dst_ip, dst_port, application)`. `last_seen` uses sweep timestamp (`now_us`), not packet time — prevents immediate expiry.

### `alert_rules` / `alert_events`

Threshold-based alerting. Rules define thresholds; events are triggered violations.

### `capture_policy`

Allowlist for the C++ daemon. Empty = capture everything. One row = strict allowlist mode. Daemon reloads inside `sync_active()` every sync_interval seconds.

### `users`

| Column | Type |
|--------|------|
| `id` | INT PK |
| `username` | VARCHAR(64) UNIQUE |
| `password_hash` | VARCHAR(255) |
| `role` | ENUM('admin','operator') |

## Indexes

Key lookup-column indexes (defined in `create_schema()` and `ensureSchema()`):

- `flows`: `(src_ip)`, `(dst_ip)`, `(application)`, `(updated_at)`, `(start_time)`, `(flow_hash)`
- `subscribers`: `(ip_address)`
- `ipdr_records`: `(src_ip, dst_ip, dst_port, application)` UNIQUE
- `application_mappings`: `(pattern_type, pattern_value)`
