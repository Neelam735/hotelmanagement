const crypto = require('node:crypto');

const SESSION_COOKIE = 'hm_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // one shift + margin

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltB64, hashB64] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    if (key) out[key] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function createAuth(db, { secureCookies = false } = {}) {
  const stmts = {
    staffByUsername: db.prepare('SELECT * FROM staff WHERE username = ?'),
    insertSession: db.prepare('INSERT INTO sessions (token, staff_id, expires_at) VALUES (?, ?, ?)'),
    sessionStaff: db.prepare(
      `SELECT s.id, s.username, s.name, s.role, s.department
         FROM sessions x JOIN staff s ON s.id = x.staff_id
        WHERE x.token = ? AND x.expires_at > ?`
    ),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
    purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
  };

  function cookie(value, maxAgeSec) {
    return [
      `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      `Max-Age=${maxAgeSec}`,
      secureCookies ? 'Secure' : null,
    ]
      .filter(Boolean)
      .join('; ');
  }

  function login(username, password) {
    const staff = stmts.staffByUsername.get(String(username || '').trim().toLowerCase());
    // Always run scrypt so response time doesn't reveal whether the user exists.
    const ok = staff
      ? verifyPassword(String(password || ''), staff.password_hash)
      : (verifyPassword(String(password || ''), hashPassword('dummy')), false);
    if (!ok) return null;

    stmts.purgeSessions.run(new Date().toISOString());
    const token = crypto.randomBytes(32).toString('base64url');
    stmts.insertSession.run(token, staff.id, new Date(Date.now() + SESSION_TTL_MS).toISOString());
    return { token, cookie: cookie(token, SESSION_TTL_MS / 1000) };
  }

  function logout(req) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) stmts.deleteSession.run(token);
    return cookie('', 0);
  }

  function currentStaff(req) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!token) return null;
    return stmts.sessionStaff.get(token, new Date().toISOString()) || null;
  }

  function requireStaff(req, res, next) {
    const staff = currentStaff(req);
    if (!staff) return res.status(401).json({ error: 'Please sign in.' });
    req.staff = staff;
    next();
  }

  function requireAdmin(req, res, next) {
    requireStaff(req, res, () => {
      if (req.staff.role !== 'admin') return res.status(403).json({ error: 'Admins only.' });
      next();
    });
  }

  return { login, logout, currentStaff, requireStaff, requireAdmin };
}

module.exports = { createAuth, hashPassword, verifyPassword, parseCookies };
