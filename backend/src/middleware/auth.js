const { verifyToken } = require('../auth');

function requireAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    req.user = verifyToken(token);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin role required' });
    }
    next();
  });
}

function requireOperator(req, res, next) {
  requireAuth(req, res, () => {
    if (!['admin', 'operator'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Operator role or higher required' });
    }
    next();
  });
}

module.exports = { requireAuth, requireAdmin, requireOperator };
