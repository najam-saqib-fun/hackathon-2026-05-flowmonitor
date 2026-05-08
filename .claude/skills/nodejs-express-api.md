---
name: Node.js Express API Patterns
description: Express route registration, MySQL2 query patterns, JWT auth, and WebSocket push for REST APIs backed by MySQL
type: reference
---

## Route Registration (Critical)

Every route file must be both `require()`'d **and** mounted in `src/index.js`. A route file that exists but is never mounted causes silent 404 on all its endpoints.

```javascript
// src/index.js
const policyRoutes  = require('./routes/policy');
const statsRoutes   = require('./routes/stats');

app.use('/api/policy', policyRoutes);
app.use('/api/stats',  statsRoutes);
```

Check registration first when any endpoint returns 404.

## MySQL2 Pool Usage

`src/db.js` exposes a `query(sql, params)` helper backed by a 20-connection promise pool. Always await it:

```javascript
const { query } = require('./db');

const rows = await query('SELECT * FROM flows WHERE src_ip = ?', [ip]);
```

Never call `pool.getConnection()` directly unless you need a transaction — the `query()` helper handles connection lifecycle.

## Derived Column Pattern (`application_category`)

`application_category` does **not exist as a column** in the `flows` table. Always derive it at query time:

```javascript
const rows = await query(`
  SELECT f.*, COALESCE(am.category, '') AS application_category
  FROM flows f
  LEFT JOIN (
    SELECT application, MIN(category) AS category
    FROM application_mappings GROUP BY application
  ) am ON am.application = f.application
  WHERE f.src_ip = ?
`, [ip]);
```

Using `f.application_category` in a WHERE clause will fail with "Unknown column". Use `am.category IS NOT NULL` instead.

## Dynamic WHERE Clause Building

Avoid `where.replace()` for appending table prefixes — it's fragile when the WHERE string contains substrings that match the pattern. Use a separate variable:

```javascript
const conditions = [];
const params = [];

if (filters.src_ip) {
  conditions.push('f.src_ip = ?');
  params.push(filters.src_ip);
}

const whereClause = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
const sql = `SELECT f.src_ip FROM flows f ${whereClause} ORDER BY f.updated_at DESC`;
const rows = await query(sql, params);
```

## Generated Columns — Never Write Them

`total_bytes` and `total_packets` in `flows` are `GENERATED ALWAYS AS ... STORED`. Any INSERT or UPDATE that includes these columns will fail. Omit them from write queries:

```javascript
// Wrong
await query('UPDATE flows SET total_bytes = ?, ... WHERE id = ?', [bytes, id]);

// Right — only write source columns
await query('UPDATE flows SET bytes_sent = ?, bytes_recv = ? WHERE id = ?', [sent, recv, id]);
```

## JWT Middleware

```javascript
const { verifyToken } = require('../auth');

function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  try {
    req.user = verifyToken(token);
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
  }
}
```

WebSocket auth uses the same `verifyToken` but via query param: `ws://host/ws?token=<jwt>`.

## Error Handling in Routes

Use `try/catch` in every async route handler. Never let unhandled promise rejections crash the server:

```javascript
router.get('/example', async (req, res) => {
  try {
    const rows = await query('SELECT ...');
    res.json(rows);
  } catch (err) {
    console.error('[route] error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});
```

## idempotent Schema Migrations

Wrap all `ALTER TABLE` and `CREATE TABLE` statements in try/catch so duplicate-column errors are logged but ignored. Both C++ and Node.js run schema creation on startup — they must not conflict:

```javascript
async function ensureSchema() {
  const stmts = [
    `CREATE TABLE IF NOT EXISTS flows (...)`,
    `ALTER TABLE flows ADD COLUMN new_col VARCHAR(64)`,  // safe to run repeatedly
  ];
  for (const sql of stmts) {
    try { await query(sql); } catch (e) { /* duplicate column — ignore */ }
  }
}
```

## Set vs Array for Type Validation

Use `Set` for O(1) membership checks on fixed lists:

```javascript
const VALID_TYPES = new Set(['exact_host', 'suffix_host', 'exact_ip', 'cidr']);

if (!VALID_TYPES.has(req.body.pattern_type)) {
  return res.status(400).json({ error: 'Invalid pattern_type' });
}
```

`Array.includes()` is O(n) and `Set.has()` is O(1) — more importantly, `Set` does not have `.includes()`, so mixing them causes `TypeError: VALID_TYPES.includes is not a function`.
