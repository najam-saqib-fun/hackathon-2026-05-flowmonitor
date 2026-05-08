---
name: Pre-PR Checklist
description: Run this before opening any pull request on FlowMon — lints backend, checks for console.log leaks, verifies route registration, and summarizes changes
type: project
---

# Pre-PR Checklist Skill

Before opening a PR on FlowMon, run through these stages in order. BLOCK the PR if any stage fails.

## Stage 1 — Static checks

1. **No `console.log` / `console.error` in backend src/**
   ```bash
   grep -rn "console\.\(log\|error\|warn\)" backend/src/ | grep -v logger.js | grep -v node_modules
   ```
   BLOCK if any results (use `logger` from `backend/src/logger.js` instead).

2. **No hardcoded credentials or secrets**
   ```bash
   grep -rn "password\s*=\s*['\"]" backend/src/ frontend/src/
   grep -rn "secret\s*=\s*['\"]" backend/src/
   ```
   BLOCK if any hits outside of `.env.example`.

3. **No raw SQL string concatenation with user input**
   ```bash
   grep -rn "WHERE.*\${" backend/src/
   grep -rn "WHERE.*+.*req\." backend/src/
   ```
   BLOCK if any hits — all user input must go through `?` placeholders.

## Stage 2 — Route registration verification

Every route file in `backend/src/routes/` must be both `require()`'d AND mounted in `backend/src/index.js`.

```bash
# List route files
ls backend/src/routes/
# Verify each appears in index.js
grep -n "require.*routes" backend/src/index.js
grep -n "app.use" backend/src/index.js
```

BLOCK if any route file is require'd but not mounted (silent 404 on all its endpoints).

## Stage 3 — Angular build check

```bash
cd frontend && npx ng build --configuration development 2>&1 | tail -20
```

BLOCK on any TypeScript error or TS1206 (decorator-class binding broken by mid-file constant).

## Stage 4 — Never-do validation

Check that none of the "Things to NEVER do" from CLAUDE.md are violated:
- No direct writes to `total_bytes` / `total_packets` columns
- No reference to `flows.application_category` as a column (must JOIN)
- No `proto.tls_quic` reads without `proto_is_tls_family()` guard (C++ only)

## Stage 5 — PR summary

Generate this summary before opening the PR:

```
## Changes
- [ ] Backend only / Frontend only / Both
- [ ] New route added (registered in index.js: yes/no)
- [ ] Schema change (ensureSchema() updated: yes/no)
- [ ] env var added (.env.example updated: yes/no)
- [ ] Breaking change to WS push format (frontend WebSocketService updated: yes/no)

## Testing done
- [ ] Ran test.sh with a PCAP
- [ ] Tested via browser (dashboard, affected routes)
- [ ] Checked for console.log leaks

## Risk level: low / medium / high
```

FIX any checklist items marked incomplete before merging.
