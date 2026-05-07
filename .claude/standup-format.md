# Standup Format — FlowMon

Daily async standup. Post in team channel or record in this file before 10:00 AM.

---

## Template

```
**Date:** YYYY-MM-DD

**Yesterday:**
- [what you shipped / merged]

**Today:**
- [what you are working on right now]

**Blockers:**
- [anything slowing you down — or "none"]

**Stats (optional):**
- Flows captured: X
- DB size: X MB
- Open issues: X
```

---

## Example Entry

```
Date: 2026-05-07

Yesterday:
- Fixed Top Talkers WS alias (bytes → total_bytes)
- Fixed WS/REST data scope mismatch — KPIs now consistent on refresh
- Added applications_summary + capture_policy to Node.js ensureSchema()

Today:
- Create SPEC.md, prompt-log.md, and personal skill files
- Commit all session changes to main

Blockers:
- None

Stats:
- Flows in DB: 8 416
- DB size: ~42 MB
- Open issues: 0
```

---

## Session Log

| Date | Yesterday | Today | Blockers |
|------|-----------|-------|----------|
| 2026-05-07 | Initial commit: full three-tier platform (C++, Node.js, Angular) | Bug fixes, specs, .md files | None |

---

## Conventions

- Keep entries short — one bullet per item.
- "Yesterday" means since the last standup, not the calendar day.
- Add a `Stats` block when running a PCAP replay or live capture, so the team can track data health over time.
- Blockers should name a person or decision needed, not just "stuck on X".
