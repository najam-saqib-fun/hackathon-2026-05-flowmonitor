# Judges' Scorecard — FlowMon

## Evaluation Rubric

| Criterion | Weight | 1 — Weak | 3 — Adequate | 5 — Strong |
|-----------|--------|----------|--------------|------------|
| **Technical depth** | 25% | Single-tier or toy data | Two tiers with basic queries | Three-tier: C++ DPI + SQL + real-time UI |
| **Problem/market fit** | 20% | Vague or generic | Real problem, unclear differentiation | Clear ISP pain point, no free self-hosted alternative exists |
| **Working demo** | 20% | Does not run | Runs with caveats | Live data flowing end-to-end, charts update in real time |
| **Code quality** | 15% | Spaghetti, no structure | Modular but inconsistent | Clean separation of concerns, documented, no known crashes |
| **Completeness** | 10% | MVP skeleton | Core features work, gaps visible | All listed features functional and tested |
| **Innovation** | 10% | Standard CRUD app | Interesting one-layer contribution | Novel combination (nDPI + real-time + IPDR + policy in one OSS tool) |

---

## Score Sheet

| Criterion | Max | Score | Notes |
|-----------|-----|-------|-------|
| Technical depth | 25 | | |
| Problem/market fit | 20 | | |
| Working demo | 20 | | |
| Code quality | 15 | | |
| Completeness | 10 | | |
| Innovation | 10 | | |
| **Total** | **100** | | |

---

## Evidence Mapping (for self-assessment)

| Criterion | Where to look |
|-----------|--------------|
| Technical depth | `src/flow_monitor.cpp` — nDPI integration, IPDR logic, canonical flow key; `backend/src/websocket.js` — WS push with subscriber JOIN |
| Problem/market fit | `SPEC.md` § Problem; PRD § Overview |
| Working demo | `demo-script.md`; live PCAP replay with `mytraffic.pcap` |
| Code quality | `CLAUDE.md` architecture sections; no `TODO`/`FIXME` in committed code |
| Completeness | PRD § Features Delivered (12 features shipped) |
| Innovation | nDPI 5.x C++ daemon + IPDR session tracking + real-time Angular dashboard + capture policy — no equivalent free/open tool |

---

## Self-Score (Pre-Submission)

| Criterion | Max | Self | Rationale |
|-----------|-----|------|-----------|
| Technical depth | 25 | 23 | Three-tier with nDPI, IPDR, IPv6; minor: no RBAC |
| Problem/market fit | 20 | 18 | ISP operator need is real; regulatory IPDR requirement is concrete |
| Working demo | 20 | 19 | Runs live; charts update; all 10 pages functional |
| Code quality | 15 | 13 | Modular, no crashes; inline comments sparse by design |
| Completeness | 10 | 9 | All 12 features shipped; IPv6 CIDR mapping not yet supported |
| Innovation | 10 | 9 | No free self-hosted equivalent combines all these layers |
| **Total** | **100** | **91** | |
