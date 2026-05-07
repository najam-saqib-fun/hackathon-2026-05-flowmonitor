-- Sample analytical queries against the flow_monitor MySQL database.
-- Use:   mysql --table flowmon < queries.sql
-- (or replace `flowmon` with whatever you set --mysql-db to)

USE flowmon;

-- 1. Top applications by traffic volume.
SELECT
    application,
    category,
    total_flows,
    total_packets_sent + total_packets_recv AS total_packets,
    total_bytes_sent   + total_bytes_recv   AS total_bytes,
    ROUND(total_duration_ms / 1000.0, 2)    AS total_seconds
FROM applications_summary
ORDER BY total_bytes DESC
LIMIT 20;

-- 2. Longest-lived flows.
SELECT
    src_ip, src_port, dst_ip, dst_port, protocol,
    application, application_category,
    ROUND(flow_duration_ms / 1000.0, 2) AS duration_s,
    total_packets, total_bytes
FROM flows
ORDER BY flow_duration_ms DESC
LIMIT 20;

-- 3. Heaviest individual flows (by total bytes).
SELECT
    src_ip, src_port, dst_ip, dst_port, protocol,
    application, application_category,
    bytes_sent, bytes_recv, total_bytes
FROM flows
ORDER BY total_bytes DESC
LIMIT 20;

-- 4. Top hostnames seen in TLS SNI / HTTP Host / DNS queries.
SELECT
    hostname,
    COUNT(DISTINCT flow_id) AS flow_count,
    MIN(first_seen) AS first_seen,
    MAX(last_seen)  AS last_seen
FROM hostnames
GROUP BY hostname
ORDER BY flow_count DESC
LIMIT 30;

-- 5. URLs accessed most often.
SELECT
    url,
    host,
    COUNT(DISTINCT flow_id) AS flow_count,
    SUM(access_count)       AS hits
FROM urls
GROUP BY url, host
ORDER BY hits DESC
LIMIT 30;

-- 6. Per-protocol flow distribution.
SELECT
    CASE protocol
        WHEN 1  THEN 'ICMP'
        WHEN 6  THEN 'TCP'
        WHEN 17 THEN 'UDP'
        ELSE CONCAT('proto=', protocol)
    END AS proto,
    COUNT(*)         AS flows,
    SUM(total_bytes) AS bytes
FROM flows
GROUP BY protocol
ORDER BY bytes DESC;

-- 7. Talkers: which IPs appear in the most flows?
SELECT ip, COUNT(*) AS flows
FROM (
    SELECT src_ip AS ip FROM flows
    UNION ALL
    SELECT dst_ip AS ip FROM flows
)
GROUP BY ip
ORDER BY flows DESC
LIMIT 20;

-- 8. Application category breakdown.
SELECT
    application_category,
    COUNT(*)         AS flows,
    SUM(total_bytes) AS bytes
FROM flows
WHERE application_category IS NOT NULL AND application_category <> ''
GROUP BY application_category
ORDER BY bytes DESC;

-- 9. Hosts each application talks to.
SELECT a.application, h.hostname, COUNT(*) AS hits
FROM hostnames h
JOIN flows a ON a.id = h.flow_id
GROUP BY a.application, h.hostname
ORDER BY hits DESC
LIMIT 30;

-- 10. Activity timeline (flows per minute).
SELECT
    DATE_FORMAT(start_time, '%Y-%m-%d %H:%i') AS minute,
    COUNT(*)         AS flows,
    SUM(total_bytes) AS bytes
FROM flows
GROUP BY minute
ORDER BY minute;
