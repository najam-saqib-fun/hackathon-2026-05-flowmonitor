---
name: Scaffold New API Route
description: Generate a new Express route file for FlowMon following project conventions — includes route file, index.js registration, and test stub
type: project
---

# Scaffold New API Route

When adding a new REST endpoint to FlowMon, follow these stages. All FlowMon routes use the same pattern — this skill encodes it.

## Required inputs

Before starting, collect:
- **Route name**: e.g., `reports` (becomes `/api/reports`)
- **Resource description**: what the route manages
- **Endpoints needed**: list of METHOD + path + description

## Stage 1 — Create route file

Create `backend/src/routes/<name>.js` using this template:

```javascript
const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const logger = require('../logger');

const router = express.Router();

// GET /api/<name>
router.get('/', requireAuth, async (req, res) => {
  try {
    // Build WHERE clause from query params
    const conditions = [];
    const params = [];
    // if (req.query.filter) { conditions.push('column = ?'); params.push(req.query.filter); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const rows = await query(`SELECT * FROM <table> ${where} ORDER BY id DESC LIMIT 100`, params);
    res.json(rows);
  } catch (err) {
    logger.error('<name>.get error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
```

**Hard rules:**
- Never use `console.log` — always `logger`
- Never concatenate user input into SQL — always `?` + params array
- Every async handler must have try/catch

## Stage 2 — Register in index.js

Add to `backend/src/index.js` in alphabetical order:

```javascript
// At the top with other requires:
const <name>Routes = require('./routes/<name>');

// With other app.use() calls:
app.use('/api/<name>', <name>Routes);

// In the /api endpoint list under the 'endpoints' key:
<name>: ['GET /api/<name>', ...],
```

BLOCK if you forget step 2 — the route file silently 404s without registration.

## Stage 3 — Update CLAUDE.md API surface

Add the new endpoints to the API surface table in CLAUDE.md under `### API surface`.

## Stage 4 — Verify

```bash
# Start the backend
cd backend && npm start &
sleep 2

# Test the new endpoint
curl -s -H "Authorization: Bearer $(curl -s -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}' | jq -r '.token')" \
  http://localhost:3000/api/<name> | jq .
```

Expected: JSON response (empty array is fine). BLOCK on 404 or 500.
