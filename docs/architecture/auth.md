# Auth Flow — FlowMon

## Login

```
Client → POST /api/auth/login {username, password}
Server → bcryptjs.compare(password, users.password_hash)
Server → jwt.sign({id, username, role}, JWT_SECRET, {expiresIn: JWT_EXPIRES_IN})
Client ← {token: "<jwt>", user: {id, username, role}}
```

Token stored in `localStorage['token']`. `AuthInterceptor` (`frontend/src/app/core/interceptors/auth.interceptor.ts`) attaches it as `Authorization: Bearer <token>` on every outgoing HTTP request.

## Route protection (backend)

```javascript
// backend/src/middleware/auth.js
function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  try { req.user = verifyToken(token); next(); }
  catch { res.status(401).json({ error: 'Unauthorized' }); }
}
```

All routes except `POST /api/auth/login` and `GET /api/health` require this middleware.

## WebSocket auth

WebSocket connections authenticate via JWT query param:

```
ws://host:3000/ws?token=<jwt>
```

The WS server (`backend/src/websocket.js`) calls `verifyToken(url.searchParams.get('token'))` on upgrade. Invalid token → socket closed with code 4001.

## Route protection (frontend)

`authGuard` (`frontend/src/app/core/guards/auth.guard.ts`) checks `localStorage['token']` and redirects to `/login` if missing or expired. Applied to all routes except `/login` in `app.routes.ts`.

## Password storage

Passwords stored as bcrypt hash (10 rounds). Admin seeded by `ensureSchema()` in `backend/src/db.js` with hash of `admin123`. Change before production.

## JWT expiry

Default 24 h (configurable via `JWT_EXPIRES_IN` env). Frontend does not auto-refresh; on expiry the next API call returns 401 and `AuthInterceptor` redirects to `/login`.

## Roles

Two roles in the `users` table: `admin` and `operator`. Route enforcement is coarse-grained (all authenticated users can call all routes). Fine-grained RBAC is a post-hackathon roadmap item.
