# FlowMon — Future Business Plan & Enhancement Roadmap

## Executive Summary

FlowMon's current platform delivers real-time flow analytics and IPDR session tracking for ISP-scale deployments. The next phase transforms it into a full **Lawful Intercept, Content Awareness, and Policy Enforcement** platform — commercially differentiated by deep payload inspection, behavioural analytics, and operator compliance tooling. This document outlines the technical enhancements, business model, and go-to-market strategy.

---

## Phase 3 — Deep Packet Inspection & Payload Awareness

### 3.1 L7 Payload Extraction

**Goal:** Move beyond protocol identification into actual content extraction for unencrypted traffic.

#### HTTP/1.1 Traffic Harvesting
- Reassemble TCP streams using `libnids` or `libpcap` stream tracking in `flow_monitor`
- Extract: `Host`, `User-Agent`, `Referer`, `Cookie`, `X-Forwarded-For`, `Content-Type`, request URI, response status code
- Persist to a `http_requests` table: `(flow_id, method, host, uri, status_code, content_type, request_size, response_size, timestamp_us)`
- Dashboard panel: HTTP activity log, searchable by host, URI pattern, or subscriber

#### DNS Response Logging (Enhanced)
- Currently: hostnames captured via nDPI. Enhancement: capture full DNS answer section — A/AAAA/CNAME records with TTL
- Enables: domain-to-IP mapping for attribution even when the HTTP request itself is encrypted (SNI-only TLS)

#### FTP / SMTP / POP3 / IMAP (Cleartext Email)
- Intercept email traffic on insecure mediums (port 25 SMTP, port 110 POP3, port 143 IMAP — all unencrypted)
- Extract: `MAIL FROM`, `RCPT TO`, `Subject` header, `From`/`To` headers, message body (text/plain parts)
- Store in `email_events` table with `(subscriber_ip, direction, from_addr, to_addr, subject, body_excerpt, timestamp_us)`
- Alert rule type: `email_keyword` — trigger on body/subject keyword match
- UI panel: Email Events viewer with subscriber filter and keyword search

#### VoIP / SIP Metadata
- SIP on UDP 5060 (unencrypted): parse `INVITE`, `BYE`, `REGISTER`; extract caller ID, callee, call duration
- RTP stream correlation for call quality metrics (jitter, packet loss)

### 3.2 TLS/HTTPS Decryption

**Note:** TLS decryption requires either (a) a MITM/SSL-inspection proxy, or (b) access to private keys. This is a lawful intercept feature — only for ISPs with legal authority (court orders, regulatory mandates).

#### Approach A — Inline SSL Inspection Proxy
- Deploy `mitmproxy` or `Squid` with SSL bump in transparent proxy mode
- `flow_monitor` reads plaintext after proxy termination
- Certificate pinning will cause client errors — requires either enterprise MDM to install CA, or end-user notification per legal requirements

#### Approach B — Private Key Upload (Server-Side)
- Operators upload TLS private keys for their own servers (e.g., captive portal HTTPS)
- `flow_monitor` feeds keys to Wireshark's `libwireshark` or nDPI's future TLS key log integration
- Limited to servers the operator controls

#### Approach C — TLS 1.2 Session Key Logging (Development/Test)
- Intercept `SSLKEYLOGFILE` from client processes in controlled lab environments
- For testing and QA only — not production-legal

#### Dashboard Integration
- Decrypted payload viewer within flow detail modal (admin-only, audit-logged)
- Keyword alert rules that fire on decrypted body content

### 3.3 Application Blocking & Rate Limiting

**Goal:** Move from passive monitoring to active policy enforcement.

#### Blocking via iptables/nftables
- `flow_monitor` emits block commands via a local control socket when a flow matches a block rule
- `flowmon-enforcer` daemon (new binary) translates socket commands to `nftables` rules:
  ```
  nft add rule inet filter forward ip saddr <src> ip daddr <dst> drop
  ```
- Rules auto-expire after configurable TTL (e.g., 5 min, 1 hr, permanent)
- Block log persisted to `block_events` table for audit trail

#### Per-Application Bandwidth Throttling
- Use `tc` (Linux Traffic Control) + `HTB` qdisc to shape per-subscriber traffic
- `flow_monitor` identifies the application; `flowmon-enforcer` sets a rate limit on the subscriber's mark:
  ```bash
  tc class change dev eth0 classid 1:<subscriber_mark> htb rate 1mbit ceil 2mbit
  ```
- Policy editor: per-application bandwidth cap per subscriber tier (Gold / Silver / Bronze)
- Real-time enforcement — changes take effect within one sync interval

#### Captive Portal Integration
- When a subscriber hits a block rule, redirect HTTP traffic to a captive portal page
- Portal can show: reason for block, contact info, data usage, upgrade CTA
- Integration with existing subscriber tiers/billing system via webhook

#### Botnet / C2 Detection
- Feed flow metadata to a local threat-intel lookup (`blocklist-ipsets` or commercial feed)
- Auto-block flows matching known C2 IPs/domains
- Alert type: `c2_detected` with severity=critical

---

## Phase 4 — Advanced Analytics & AI

### 4.1 Behavioural Anomaly Detection
- Baseline per-subscriber bandwidth profile (7-day rolling average, hourly buckets)
- Z-score deviation alert: flag subscribers deviating > 3σ from baseline
- Time-series model per application — detect unusual YouTube binge at 3 AM vs normal daytime use

### 4.2 Subscriber Usage Intelligence
- Daily/weekly usage reports per subscriber (auto-generated PDF)
- Top applications, peak hours, data cap consumption
- Exportable to billing systems via webhook or CSV

### 4.3 AI-Assisted Threat Classification
- Fine-tune a small classifier on flow feature vectors (bytes, packets, inter-arrival time, port entropy)
- Output: `threat_score` 0–100 attached to each flow
- Pipeline: `flow_monitor` → feature extraction → ONNX model inference → `threat_score` column in flows table

### 4.4 GeoIP Map Widget
- MaxMind GeoLite2 already wired in `.env` — path `GEOIP_DB_PATH`
- Add `src_country`, `dst_country`, `src_lat`, `src_lon`, `dst_lat`, `dst_lon` columns to flows
- Dashboard: world map (Leaflet.js) with flow arcs coloured by application or threat score
- Filter: click a country to drill into flows originating/terminating there

---

## Phase 5 — Compliance & Lawful Intercept

### 5.1 CALEA / LI Interface
- Implement ETSI LI (Lawful Intercept) handover interface (HI1/HI2/HI3)
- IPDR records are already structurally compliant — add LI export endpoint
- Secure handover to law enforcement via mTLS + signed PKCS#7 bundles

### 5.2 Data Retention Policy Engine
- Configurable retention per data type: flows (90 days default), IPDR (1 year), email events (2 years)
- Automated purge job (`DELETE FROM flows WHERE start_time < NOW() - INTERVAL ? DAY`)
- Retention policy UI in admin panel

### 5.3 Audit Log
- All admin actions (policy changes, block rules, key uploads, data exports) written to immutable `audit_log` table
- Tamper-evident via SHA-256 hash chain (each row hashes previous row's hash + content)
- Export to SIEM (syslog/CEF format)

### 5.4 Multi-Tenant Support
- `tenant_id` column on all tables
- Row-level security enforced at API layer — operators see only their own data
- Tenant admin can manage their subscribers, policies, and alerts independently
- Super-admin sees all tenants (ISP parent company view)

---

## Phase 6 — Monetisation & Business Model

### SaaS / Managed Service Tier

| Tier | Price (est.) | Features |
|------|-------------|----------|
| **Starter** | $299/mo | Up to 500 subscribers, flow analytics, basic alerts, 90-day retention |
| **Professional** | $999/mo | Up to 5,000 subscribers, HTTP extraction, email events, GeoIP map, PDF reports |
| **Enterprise** | Custom | Unlimited subscribers, TLS inspection, LI handover, multi-tenant, SLA, on-prem option |

### Revenue Streams
1. **SaaS subscriptions** — primary recurring revenue
2. **Professional services** — custom integrations, LI compliance setup, training
3. **Threat intel feed** — resell commercial IP/domain blocklists bundled with FlowMon subscription
4. **Usage-based API** — charge per GB of packet data processed (metered for large ISPs)

### Target Markets
- **Regional ISPs & WISPs** — primary TAM; under-served by enterprise solutions like Sandvine/Allot
- **Enterprise NOC teams** — internal network visibility without ISP-grade licensing cost
- **Government / regulatory bodies** — LI compliance tooling for telecom operators
- **Managed Security Providers** — resell FlowMon-powered analytics to downstream clients

---

## Phase 7 — Infrastructure & Scalability

### Horizontal Scale
- Current: single `flow_monitor` instance per NIC
- Plan: Kafka-backed ingestion pipeline — multiple capture instances publish `PacketMessage` to a Kafka topic; a pool of `flow_aggregator` workers consume and write to MySQL (or ClickHouse for analytics)

### ClickHouse for Analytics
- Move read-heavy analytics queries (`top-apps`, `bandwidth`, `top-talkers`) to ClickHouse
- MySQL remains the operational store for live flows and config
- ClickHouse's columnar storage handles 10B+ rows efficiently for historical trend queries

### High Availability
- Active-active MySQL with Galera Cluster or AWS Aurora
- Stateless Node.js API behind a load balancer
- `flow_monitor` failover via VRRP (two capture nodes, one active)

---

## Implementation Priority Order

| Priority | Enhancement | Effort | Value |
|----------|-------------|--------|-------|
| 1 | GeoIP map widget | Low (data ready) | Medium |
| 2 | HTTP payload extraction | Medium | High |
| 3 | Application blocking (iptables) | Medium | High |
| 4 | Cleartext email interception | Medium | High (compliance) |
| 5 | Bandwidth throttling (tc/HTB) | Medium | High |
| 6 | PDF usage reports | Medium | Medium |
| 7 | Behavioural anomaly baseline | High | High |
| 8 | TLS inspection proxy | High | Very High |
| 9 | Multi-tenant support | High | Very High |
| 10 | CALEA/LI handover interface | Very High | Critical (compliance market) |
| 11 | ClickHouse analytics backend | High | High (scale) |
| 12 | AI threat classifier | Very High | Medium |

---

## Legal & Ethical Framework

> All payload inspection, email capture, and TLS decryption features must be deployed in compliance with applicable law. FlowMon does not enable warrantless surveillance. ISPs deploying these features are responsible for:
> - Obtaining required legal authority (court orders, regulatory licences)
> - Notifying end users per applicable privacy law (GDPR, CCPA, local telecom regulations)
> - Implementing data minimisation — capture only what is legally required
> - Securing captured data against unauthorised access (encryption at rest, mTLS in transit)
> - Enforcing access controls — only designated Lawful Intercept officers may view intercepted content

FlowMon's default configuration captures **metadata only** (5-tuple, byte counts, application name). Payload features are disabled by default and require explicit operator enablement plus acknowledgement of the legal framework.
