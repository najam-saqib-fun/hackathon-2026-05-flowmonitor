# Post-Hackathon Roadmap — FlowMon

## Status: Beta → Shippable

What's needed to take this from 3-day proof-of-concept to production-shippable:

---

## Security Hardening (P0)

- [ ] Migrate JWT from `localStorage` to HttpOnly + Secure cookie with CSRF token (XSS exfiltration risk documented in technical-decisions.md)
- [ ] Fine-grained RBAC: `operator` role should be read-only on config routes (alerts/mappings/policy)
- [ ] TLS on the API/WS server (currently HTTP; deploy behind nginx/caddy with Let's Encrypt)
- [ ] Input sanitization audit: verify all `req.query` parameters are typed and bounded before use in SQL
- [ ] Change default `admin`/`admin123` to forced-reset on first login
- [ ] Secrets rotation: JWT secret, DB password must be env-managed; add rotation runbook

## DB Hardening (P0)

- [ ] Add foreign key constraints (`flows → subscribers`, `ipdr_records → flows` where applicable)
- [ ] Partition `flows` table by `start_time` month — table will grow unbounded in production
- [ ] Add `flows` purge policy (cron job to delete rows older than N days; configurable)
- [ ] Migrate `hostnames`/`urls` from JSON columns to a proper `flow_hostnames` table (indexable)
- [ ] Replication setup: MySQL primary → read replica for analytics queries off the write path

## QA Pipeline (P0)

- [ ] Unit tests for all backend routes (Jest + supertest), targeting >80% coverage
- [ ] E2E tests via Playwright for: login → dashboard → flows → IPDR → logout
- [ ] CI pipeline (GitHub Actions): lint + typecheck + unit tests on every PR
- [ ] Integration test with a real PCAP (extend `test.sh` to assert DB row counts)

## Missing Features (P1)

- [ ] GeoIP: render `src_ip` geolocation on a world map (MaxMind GeoLite2 already wired in backend)
- [ ] Subscriber reports: per-subscriber bandwidth/flow/top-app breakdown with date range
- [ ] Alerting webhook: POST to external URL on alert event (currently WS-only notification)
- [ ] IPv6 CIDR app mapping (currently only IPv4 CIDR; IPv6 covered by SNI matching but not CIDR)
- [ ] Dark/light theme toggle in the Angular UI

## Observability (P1)

- [ ] Connect `SENTRY_DSN` to production Sentry project and verify source maps upload on build
- [ ] Connect `POSTHOG_API_KEY` and instrument: login, dashboard visit, flow search, IPDR export
- [ ] Structured log shipping: configure Winston transport to send logs to Datadog / Loki
- [ ] Alerting integration: wire `alert_events` to PagerDuty or Slack webhook

## Performance (P2)

- [ ] Redis cache layer for `/api/stats/overview` and `/api/stats/top-apps` (TTL 30 s)
- [ ] Pre-aggregate `applications_summary` table on a 1-minute cron instead of query-time aggregation
- [ ] Benchmark `flows` table at 10M rows; add covering indexes as needed
- [ ] Frontend: virtual scrolling for the flows table (currently loads up to 200 rows into DOM)

## Deployment (P2)

- [ ] Docker Compose file: `flow_monitor` + `backend` + MySQL in containers
- [ ] Helm chart for Kubernetes deployment
- [ ] One-click deploy to DigitalOcean App Platform or Railway
- [ ] `CONTRIBUTING.md` and developer setup guide for open-source contributors
