-- Retroactively re-map already-persisted flows using application_mappings.
-- Safe to run multiple times. Run AFTER restarting flow_monitor at least
-- once so the application_mappings table exists and is seeded.
--
-- Usage:
--   mysql -u<user> -p flowmon < backfill_mappings.sql

USE flowmon;

-- Pick the longest-matching pattern per flow (most specific wins) and update
-- flows.application + flows.application_category in place. The original
-- protocol (TLS/DNS/etc.) is preserved in metadata.master_protocol below.
UPDATE flows f
JOIN (
    SELECT
        h.flow_id,
        SUBSTRING_INDEX(
            GROUP_CONCAT(am.application
                         ORDER BY CHAR_LENGTH(am.pattern) DESC
                         SEPARATOR '\n'),
            '\n', 1) AS application,
        SUBSTRING_INDEX(
            GROUP_CONCAT(IFNULL(am.category, '')
                         ORDER BY CHAR_LENGTH(am.pattern) DESC
                         SEPARATOR '\n'),
            '\n', 1) AS category
    FROM hostnames h
    JOIN application_mappings am ON
        (am.pattern_type = 'hostname_exact'
         AND LOWER(h.hostname) = LOWER(am.pattern))
     OR (am.pattern_type = 'hostname_suffix'
         AND (LOWER(h.hostname) = LOWER(am.pattern)
           OR LOWER(h.hostname) LIKE CONCAT('%.', LOWER(am.pattern))))
    GROUP BY h.flow_id
) m ON m.flow_id = f.id
SET f.application          = m.application,
    f.application_category = NULLIF(m.category, '')
WHERE f.application IN ('TLS', 'DNS', 'QUIC', 'HTTP', 'HTTPS', 'Unknown', '')
   OR f.application <> m.application;

-- IP-only fallback: flows with no hostname can still be tagged via ip_exact.
UPDATE flows f
JOIN application_mappings am
  ON am.pattern_type = 'ip_exact'
 AND (am.pattern = f.dst_ip OR am.pattern = f.src_ip)
SET f.application          = am.application,
    f.application_category = COALESCE(am.category, f.application_category)
WHERE f.application IN ('TLS', 'DNS', 'QUIC', 'HTTP', 'HTTPS', 'Unknown', '');

-- Rebuild applications_summary so totals match the new app names.
TRUNCATE TABLE applications_summary;

INSERT INTO applications_summary
    (application, category, total_flows,
     total_packets_sent, total_packets_recv,
     total_bytes_sent,   total_bytes_recv,
     total_duration_ms, first_seen, last_seen, last_updated)
SELECT
    application,
    MAX(application_category),
    COUNT(*),
    SUM(packet_sent), SUM(packet_recv),
    SUM(bytes_sent),  SUM(bytes_recv),
    SUM(flow_duration_ms),
    MIN(start_time),  MAX(end_time),
    NOW()
FROM flows
WHERE application IS NOT NULL AND application <> '' AND application <> 'Unknown'
GROUP BY application;

-- Quick sanity check.
SELECT application, application_category, COUNT(*) AS flows
FROM flows
GROUP BY application, application_category
ORDER BY flows DESC
LIMIT 20;
