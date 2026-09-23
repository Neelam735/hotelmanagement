const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const QRCode = require('qrcode');

const { openDatabase, newRoomToken } = require('./db');
const { createAuth, hashPassword, verifyPassword, parseCookies } = require('./auth');
const { createEventHub } = require('./events');
const {
  DEPARTMENTS,
  SERVICES,
  SERVICE_MAP,
  STATUSES,
  OPEN_STATUSES,
  validateDetails,
  summarize,
} = require('./services');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// Guest abuse limits: someone who photographs a QR code shouldn't be able to
// flood the dashboard. Open requests are limited per phone so a stray device
// can't lock the real guest out; the hourly cap per room is the backstop.
const GUEST_WINDOW_MS = 60 * 60 * 1000;
const GUEST_MAX_PER_WINDOW = 30;
const GUEST_MAX_OPEN_PER_DEVICE = 10;

// Each guest phone gets a random device id. A room's QR link never changes
// between stays, so without this a previous guest could reopen the link and
// read the next guest's requests.
const DEVICE_COOKIE = 'hm_device';
const DEVICE_TTL_SEC = 60 * 24 * 60 * 60;

// Staff login throttling (per IP + username).
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;
const NOTE_MAX = 500;
const REPLY_MAX = 500;

function createApp(options = {}) {
  const {
    dbFile = ':memory:',
    adminUsername = 'admin',
    adminPassword,
    publicUrl,
    secureCookies = false,
    trustProxy = false,
    logger = console,
  } = options;

  const db = openDatabase(dbFile);
  const auth = createAuth(db, { secureCookies });
  const hub = createEventHub();

  // First run: create the admin account.
  const staffCount = db.prepare('SELECT COUNT(*) AS n FROM staff').get().n;
  let generatedAdminPassword = null;
  if (staffCount === 0) {
    const password = adminPassword || (generatedAdminPassword = crypto.randomBytes(9).toString('base64url'));
    db.prepare('INSERT INTO staff (username, name, role, password_hash) VALUES (?, ?, ?, ?)').run(
      adminUsername.toLowerCase(),
      'Administrator',
      'admin',
      hashPassword(password)
    );
    if (generatedAdminPassword) {
      logger.log(`\n  Created admin account -> username: ${adminUsername}  password: ${generatedAdminPassword}`);
      logger.log('  (set ADMIN_PASSWORD to choose your own; change it after first login)\n');
    }
  }

  const q = {
    settings: db.prepare('SELECT key, value FROM settings'),
    setSetting: db.prepare('UPDATE settings SET value = ? WHERE key = ?'),
    roomByToken: db.prepare('SELECT * FROM rooms WHERE token = ?'),
    roomById: db.prepare('SELECT * FROM rooms WHERE id = ?'),
    rooms: db.prepare(
      `SELECT r.*,
              (SELECT COUNT(*) FROM requests x
                WHERE x.room_id = r.id AND x.status IN ('new','acknowledged','in_progress')) AS open_requests
         FROM rooms r ORDER BY CAST(r.number AS INTEGER), r.number`
    ),
    insertRoom: db.prepare('INSERT INTO rooms (number, floor, token) VALUES (?, ?, ?)'),
    deleteRoom: db.prepare('DELETE FROM rooms WHERE id = ?'),
    setRoomToken: db.prepare('UPDATE rooms SET token = ? WHERE id = ?'),
    setDnd: db.prepare('UPDATE rooms SET dnd = ? WHERE id = ?'),
    checkout: db.prepare(
      `UPDATE rooms SET dnd = 0, stay_started_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
    ),
    cancelOpenForRoom: db.prepare(
      `UPDATE requests SET status = 'cancelled', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE room_id = ? AND status IN ('new','acknowledged','in_progress')`
    ),
    insertRequest: db.prepare(
      'INSERT INTO requests (room_id, service, department, details, note, device_id) VALUES (?, ?, ?, ?, ?, ?)'
    ),
    requestById: db.prepare(
      `SELECT x.*, r.number AS room_number, r.dnd AS room_dnd
         FROM requests x JOIN rooms r ON r.id = x.room_id WHERE x.id = ?`
    ),
    guestRequests: db.prepare(
      `SELECT x.*, r.number AS room_number, r.dnd AS room_dnd
         FROM requests x JOIN rooms r ON r.id = x.room_id
        WHERE x.room_id = ? AND x.device_id = ? AND x.created_at >= ?
        ORDER BY x.created_at DESC LIMIT 50`
    ),
    openCountForDevice: db.prepare(
      `SELECT COUNT(*) AS n FROM requests
        WHERE room_id = ? AND device_id = ? AND status IN ('new','acknowledged','in_progress')`
    ),
    recentCountForRoom: db.prepare('SELECT COUNT(*) AS n FROM requests WHERE room_id = ? AND created_at >= ?'),
    updateRequest: db.prepare(
      `UPDATE requests SET status = ?, staff_reply = ?, handled_by = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`
    ),
    staffList: db.prepare('SELECT id, username, name, role, department, created_at FROM staff ORDER BY name'),
    insertStaff: db.prepare(
      'INSERT INTO staff (username, name, role, department, password_hash) VALUES (?, ?, ?, ?, ?)'
    ),
    deleteStaff: db.prepare('DELETE FROM staff WHERE id = ?'),
    setPassword: db.prepare('UPDATE staff SET password_hash = ? WHERE id = ?'),
    staffHash: db.prepare('SELECT password_hash FROM staff WHERE id = ?'),
    adminCount: db.prepare(`SELECT COUNT(*) AS n FROM staff WHERE role = 'admin'`),
    staffById: db.prepare('SELECT id, role FROM staff WHERE id = ?'),
  };

  function getSettings() {
    return Object.fromEntries(q.settings.all().map((r) => [r.key, r.value]));
  }

  function formatRequest(row, { forGuest = false } = {}) {
    const service = SERVICE_MAP.get(row.service);
    const details = JSON.parse(row.details || '{}');
    const out = {
      id: row.id,
      roomNumber: row.room_number,
      service: row.service,
      serviceName: service ? service.name : row.service,
      icon: service ? service.icon : '❔',
      department: row.department,
      details,
      summary: summarize(service, details),
      note: row.note || '',
      status: row.status,
      staffReply: row.staff_reply || '',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    if (!forGuest) {
      out.roomId = row.room_id;
      out.roomDnd = Boolean(row.room_dnd);
      out.handledBy = row.handled_by || '';
    }
    return out;
  }

  function formatRoom(row) {
    return {
      id: row.id,
      number: row.number,
      floor: row.floor || '',
      dnd: Boolean(row.dnd),
      stayStartedAt: row.stay_started_at,
      openRequests: row.open_requests ?? undefined,
    };
  }

  function baseUrl(req) {
    return (publicUrl || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  }

  function guestUrl(req, room) {
    return `${baseUrl(req)}/r/${room.token}`;
  }

  function publishRequest(type, row) {
    hub.publish(type, {
      roomId: row.room_id,
      deviceId: row.device_id,
      request: formatRequest(row),
      guestRequest: formatRequest(row, { forGuest: true }),
    });
  }

  const app = express();
  app.disable('x-powered-by');
  if (trustProxy) app.set('trust proxy', trustProxy);
  app.use(express.json({ limit: '32kb' }));
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Frame-Options', 'DENY');
    res.set(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
    );
    next();
  });

  // State-changing API calls must be JSON; this blocks cross-site HTML form
  // posts even in browsers that ignore SameSite cookies.
  app.use('/api', (req, res, next) => {
    const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
    if (mutating && req.headers['content-type'] && !req.is('application/json')) {
      return res.status(415).json({ error: 'Expected application/json.' });
    }
    next();
  });

  // ---------------------------------------------------------------- pages
  app.get('/', (req, res) => res.redirect('/staff'));
  app.get('/r/:token', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'guest.html')));
  app.get('/login', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'login.html')));
  app.get('/staff', (req, res) => {
    if (!auth.currentStaff(req)) return res.redirect('/login?next=/staff');
    res.sendFile(path.join(PUBLIC_DIR, 'staff.html'));
  });
  app.get('/admin', (req, res) => {
    const staff = auth.currentStaff(req);
    if (!staff) return res.redirect('/login?next=/admin');
    if (staff.role !== 'admin') return res.redirect('/staff');
    res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
  });
  app.get('/admin/qr-print', (req, res) => {
    const staff = auth.currentStaff(req);
    if (!staff || staff.role !== 'admin') return res.redirect('/login?next=/admin');
    res.sendFile(path.join(PUBLIC_DIR, 'qr-print.html'));
  });
  app.use('/static', express.static(PUBLIC_DIR, { index: false, maxAge: '1h' }));

  // ---------------------------------------------------------------- guest API
  function loadRoom(req, res, next) {
    const room = q.roomByToken.get(String(req.params.token));
    if (!room) return res.status(404).json({ error: 'This QR code is no longer valid. Please contact reception.' });
    req.room = room;

    let deviceId = parseCookies(req.headers.cookie)[DEVICE_COOKIE];
    if (!/^[\w-]{22,64}$/.test(deviceId || '')) {
      deviceId = crypto.randomBytes(18).toString('base64url');
      res.append(
        'Set-Cookie',
        [
          `${DEVICE_COOKIE}=${deviceId}`,
          'Path=/api/guest',
          'HttpOnly',
          'SameSite=Lax',
          `Max-Age=${DEVICE_TTL_SEC}`,
          secureCookies ? 'Secure' : null,
        ]
          .filter(Boolean)
          .join('; ')
      );
    }
    req.deviceId = deviceId;
    next();
  }

  app.get('/api/guest/:token', loadRoom, (req, res) => {
    const s = getSettings();
    res.json({
      hotel: {
        name: s.hotel_name,
        receptionPhone: s.reception_phone,
        wifiName: s.wifi_name,
        wifiPassword: s.wifi_password,
        welcomeMessage: s.welcome_message,
      },
      room: { number: req.room.number, dnd: Boolean(req.room.dnd) },
      services: SERVICES,
      requests: q.guestRequests
        .all(req.room.id, req.deviceId, req.room.stay_started_at)
        .map((r) => formatRequest(r, { forGuest: true })),
    });
  });

  app.post('/api/guest/:token/requests', loadRoom, (req, res) => {
    const room = req.room;
    const service = SERVICE_MAP.get(req.body?.service);
    if (!service) return res.status(400).json({ error: 'Unknown service.' });

    const result = validateDetails(service, req.body.details);
    if (!result.ok) return res.status(400).json({ error: result.error });

    const note = typeof req.body.note === 'string' ? req.body.note.trim() : '';
    if (note.length > NOTE_MAX) return res.status(400).json({ error: `Note is too long (max ${NOTE_MAX} characters).` });

    const since = new Date(Date.now() - GUEST_WINDOW_MS).toISOString();
    if (q.recentCountForRoom.get(room.id, since).n >= GUEST_MAX_PER_WINDOW) {
      return res.status(429).json({ error: 'Too many requests from this room. Please call reception.' });
    }
    if (q.openCountForDevice.get(room.id, req.deviceId).n >= GUEST_MAX_OPEN_PER_DEVICE) {
      return res.status(429).json({ error: 'You have many open requests. Please wait for them to be completed.' });
    }

    const info = q.insertRequest.run(
      room.id,
      service.id,
      service.department,
      JSON.stringify(result.details),
      note || null,
      req.deviceId
    );
    const row = q.requestById.get(info.lastInsertRowid);
    publishRequest('request:new', row);
    res.status(201).json({ request: formatRequest(row, { forGuest: true }) });
  });

  app.post('/api/guest/:token/requests/:id/cancel', loadRoom, (req, res) => {
    const row = q.requestById.get(Number(req.params.id));
    if (!row || row.room_id !== req.room.id || row.device_id !== req.deviceId) {
      return res.status(404).json({ error: 'Request not found.' });
    }
    if (!['new', 'acknowledged'].includes(row.status)) {
      return res.status(409).json({ error: 'This request is already being handled and can no longer be cancelled.' });
    }
    q.updateRequest.run('cancelled', row.staff_reply, row.handled_by, row.id);
    const updated = q.requestById.get(row.id);
    publishRequest('request:update', updated);
    res.json({ request: formatRequest(updated, { forGuest: true }) });
  });

  app.post('/api/guest/:token/dnd', loadRoom, (req, res) => {
    const dnd = Boolean(req.body?.dnd);
    q.setDnd.run(dnd ? 1 : 0, req.room.id);
    hub.publish('room:update', { roomId: req.room.id, room: formatRoom(q.roomById.get(req.room.id)) });
    res.json({ dnd });
  });

  app.get('/api/guest/:token/stream', loadRoom, (req, res) => {
    const { id: roomId, token } = req.room;
    const deviceId = req.deviceId;
    hub.subscribe(
      req,
      res,
      (type, payload) => {
        if (payload.roomId !== roomId) return false;
        // Stop streaming to a link that has been replaced with a new QR code.
        if (q.roomByToken.get(token)?.id !== roomId) return 'drop';
        return type === 'room:update' || payload.deviceId === deviceId;
      },
      (type, payload) =>
        payload.guestRequest ? { request: payload.guestRequest } : { room: { dnd: payload.room.dnd }, reset: payload.reset }
    );
  });

  // ---------------------------------------------------------------- auth API
  const loginFailures = new Map(); // "ip|username" -> [timestamps]
  app.post('/api/auth/login', (req, res) => {
    const key = `${req.ip}|${String(req.body?.username || '').trim().toLowerCase()}`;
    const cutoff = Date.now() - LOGIN_WINDOW_MS;
    const recent = (loginFailures.get(key) || []).filter((t) => t > cutoff);
    if (recent.length >= LOGIN_MAX_FAILURES) {
      return res.status(429).json({ error: 'Too many failed sign-in attempts. Please wait 15 minutes.' });
    }
    const session = auth.login(req.body?.username, req.body?.password);
    if (!session) {
      recent.push(Date.now());
      loginFailures.set(key, recent);
      if (loginFailures.size > 10000) loginFailures.delete(loginFailures.keys().next().value);
      return res.status(401).json({ error: 'Invalid username or password.' });
    }
    loginFailures.delete(key);
    res.set('Set-Cookie', session.cookie);
    res.json({ ok: true });
  });

  app.post('/api/auth/logout', (req, res) => {
    res.set('Set-Cookie', auth.logout(req));
    res.json({ ok: true });
  });

  app.get('/api/auth/me', auth.requireStaff, (req, res) => res.json({ staff: req.staff }));

  app.post('/api/auth/password', auth.requireStaff, (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (!verifyPassword(String(currentPassword || ''), q.staffHash.get(req.staff.id).password_hash)) {
      return res.status(400).json({ error: 'Current password is incorrect.' });
    }
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters.' });
    }
    q.setPassword.run(hashPassword(newPassword), req.staff.id);
    auth.logoutOtherSessions(req);
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- staff API
  app.get('/api/meta', auth.requireStaff, (req, res) => {
    res.json({ departments: DEPARTMENTS, services: SERVICES, statuses: STATUSES });
  });

  app.get('/api/staff/requests', auth.requireStaff, (req, res) => {
    const scope = req.query.scope === 'all' ? 'all' : 'open';
    const where = [];
    const params = [];
    if (scope === 'open') {
      where.push(`x.status IN (${OPEN_STATUSES.map(() => '?').join(',')})`);
      params.push(...OPEN_STATUSES);
    } else {
      where.push('x.created_at >= ?');
      params.push(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());
    }
    if (req.query.department && DEPARTMENTS[req.query.department]) {
      where.push('x.department = ?');
      params.push(req.query.department);
    }
    const rows = db
      .prepare(
        `SELECT x.*, r.number AS room_number, r.dnd AS room_dnd
           FROM requests x JOIN rooms r ON r.id = x.room_id
          WHERE ${where.join(' AND ')}
          ORDER BY x.created_at DESC LIMIT 500`
      )
      .all(...params);
    res.json({ requests: rows.map((r) => formatRequest(r)) });
  });

  app.patch('/api/staff/requests/:id', auth.requireStaff, (req, res) => {
    const row = q.requestById.get(Number(req.params.id));
    if (!row) return res.status(404).json({ error: 'Request not found.' });

    const status = req.body?.status ?? row.status;
    if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status.' });

    let reply = row.staff_reply;
    if (req.body?.staffReply !== undefined) {
      if (typeof req.body.staffReply !== 'string') return res.status(400).json({ error: 'Reply must be text.' });
      reply = req.body.staffReply.trim().slice(0, REPLY_MAX) || null;
    }

    q.updateRequest.run(status, reply, req.staff.name, row.id);
    const updated = q.requestById.get(row.id);
    publishRequest('request:update', updated);
    res.json({ request: formatRequest(updated) });
  });

  app.get('/api/staff/rooms', auth.requireStaff, (req, res) => {
    res.json({ rooms: q.rooms.all().map(formatRoom) });
  });

  // New guest checked in / previous guest checked out: hides old history from
  // the guest page, clears DND, and closes anything still open.
  app.post('/api/staff/rooms/:id/checkout', auth.requireStaff, (req, res) => {
    const room = q.roomById.get(Number(req.params.id));
    if (!room) return res.status(404).json({ error: 'Room not found.' });
    q.cancelOpenForRoom.run(room.id);
    q.checkout.run(room.id);
    hub.publish('room:update', { roomId: room.id, room: formatRoom(q.roomById.get(room.id)), reset: true });
    res.json({ ok: true });
  });

  app.get('/api/staff/stream', auth.requireStaff, (req, res) => {
    hub.subscribe(
      req,
      res,
      // Stop streaming once the session ends (sign-out, expiry, account removed).
      () => (auth.currentStaff(req) ? true : 'drop'),
      (type, { guestRequest, deviceId, ...rest }) => rest
    );
  });

  // ---------------------------------------------------------------- admin API
  app.get('/api/admin/rooms', auth.requireAdmin, (req, res) => {
    res.json({
      rooms: q.rooms.all().map((r) => ({ ...formatRoom(r), guestUrl: guestUrl(req, r) })),
    });
  });

  app.post('/api/admin/rooms', auth.requireAdmin, (req, res) => {
    const floor = typeof req.body?.floor === 'string' ? req.body.floor.trim().slice(0, 20) : '';
    let numbers = [];
    if (req.body?.from !== undefined || req.body?.to !== undefined) {
      const from = Number(req.body.from);
      const to = Number(req.body.to);
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to - from > 500) {
        return res.status(400).json({ error: 'Give a valid range (at most 500 rooms at once).' });
      }
      for (let n = from; n <= to; n++) numbers.push(String(n));
    } else {
      const number = typeof req.body?.number === 'string' ? req.body.number.trim() : String(req.body?.number ?? '');
      if (!/^[\w-]{1,20}$/.test(number)) {
        return res.status(400).json({ error: 'Room number must be 1-20 letters, digits or dashes.' });
      }
      numbers = [number];
    }

    const created = [];
    const skipped = [];
    for (const number of numbers) {
      try {
        q.insertRoom.run(number, floor || null, newRoomToken());
        created.push(number);
      } catch (err) {
        if (String(err.message).includes('UNIQUE')) skipped.push(number);
        else throw err;
      }
    }
    res.status(201).json({ created, skipped });
  });

  app.delete('/api/admin/rooms/:id', auth.requireAdmin, (req, res) => {
    const info = q.deleteRoom.run(Number(req.params.id));
    if (!info.changes) return res.status(404).json({ error: 'Room not found.' });
    res.json({ ok: true });
  });

  // Invalidates the printed QR code (e.g. if a code was copied or leaked).
  app.post('/api/admin/rooms/:id/rotate-token', auth.requireAdmin, (req, res) => {
    const room = q.roomById.get(Number(req.params.id));
    if (!room) return res.status(404).json({ error: 'Room not found.' });
    q.setRoomToken.run(newRoomToken(), room.id);
    res.json({ ok: true });
  });

  app.get('/api/admin/rooms/:id/qr.svg', auth.requireAdmin, async (req, res, next) => {
    try {
      const room = q.roomById.get(Number(req.params.id));
      if (!room) return res.status(404).json({ error: 'Room not found.' });
      const svg = await QRCode.toString(guestUrl(req, room), { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
      res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg);
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/admin/settings', auth.requireAdmin, (req, res) => res.json({ settings: getSettings() }));

  app.put('/api/admin/settings', auth.requireAdmin, (req, res) => {
    const current = getSettings();
    for (const key of Object.keys(current)) {
      const value = req.body?.[key];
      if (value === undefined) continue;
      if (typeof value !== 'string' || value.length > 500) {
        return res.status(400).json({ error: `Invalid value for ${key}.` });
      }
      q.setSetting.run(value.trim(), key);
    }
    res.json({ settings: getSettings() });
  });

  app.get('/api/admin/staff', auth.requireAdmin, (req, res) => res.json({ staff: q.staffList.all() }));

  app.post('/api/admin/staff', auth.requireAdmin, (req, res) => {
    const { username, name, password, role = 'staff', department = null } = req.body || {};
    const uname = String(username || '').trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,32}$/.test(uname)) {
      return res.status(400).json({ error: 'Username must be 3-32 characters (letters, digits, . _ -).' });
    }
    if (typeof name !== 'string' || !name.trim() || name.length > 80) {
      return res.status(400).json({ error: 'Name is required.' });
    }
    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }
    if (!['staff', 'admin'].includes(role)) return res.status(400).json({ error: 'Invalid role.' });
    if (department !== null && department !== '' && !DEPARTMENTS[department]) {
      return res.status(400).json({ error: 'Invalid department.' });
    }
    try {
      q.insertStaff.run(uname, name.trim(), role, department || null, hashPassword(password));
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: 'Username already exists.' });
      throw err;
    }
    res.status(201).json({ staff: q.staffList.all() });
  });

  app.delete('/api/admin/staff/:id', auth.requireAdmin, (req, res) => {
    const target = q.staffById.get(Number(req.params.id));
    if (!target) return res.status(404).json({ error: 'Staff member not found.' });
    if (target.id === req.staff.id) return res.status(400).json({ error: 'You cannot delete your own account.' });
    if (target.role === 'admin' && q.adminCount.get().n <= 1) {
      return res.status(400).json({ error: 'At least one admin is required.' });
    }
    q.deleteStaff.run(target.id);
    res.json({ staff: q.staffList.all() });
  });

  // ---------------------------------------------------------------- errors
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large.' });
    logger.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  });

  function close() {
    hub.closeAll();
    db.close();
  }

  return { app, db, close, generatedAdminPassword };
}

module.exports = { createApp };
