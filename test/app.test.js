const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../src/app');

let server;
let base;
let ctx;

before(async () => {
  ctx = createApp({ dbFile: ':memory:', adminPassword: 'admin-pass-123', logger: { log() {}, error() {} } });
  server = http.createServer(ctx.app);
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  ctx.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

async function call(method, path, { body, cookie, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    redirect: 'manual',
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text, headers: res.headers };
}

async function login(username, password) {
  const res = await call('POST', '/api/auth/login', { body: { username, password } });
  assert.equal(res.status, 200, res.text);
  return res.headers.get('set-cookie').split(';')[0];
}

async function createRoom(cookie, number) {
  const res = await call('POST', '/api/admin/rooms', { cookie, body: { number } });
  assert.equal(res.status, 201, res.text);
  const { json } = await call('GET', '/api/admin/rooms', { cookie });
  const room = json.rooms.find((r) => r.number === number);
  return { ...room, token: room.guestUrl.split('/r/')[1] };
}

test('staff endpoints require login', async () => {
  assert.equal((await call('GET', '/api/staff/requests')).status, 401);
  assert.equal((await call('GET', '/api/admin/rooms')).status, 401);
  const page = await call('GET', '/staff');
  assert.equal(page.status, 302);
  assert.match(page.headers.get('location'), /^\/login/);
});

test('login rejects bad credentials', async () => {
  const res = await call('POST', '/api/auth/login', { body: { username: 'admin', password: 'nope' } });
  assert.equal(res.status, 401);
});

test('full guest request lifecycle', async () => {
  const admin = await login('admin', 'admin-pass-123');
  const room = await createRoom(admin, '101');

  // Guest opens the page from the QR code.
  const page = await call('GET', `/r/${room.token}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Room Services/);

  const info = await call('GET', `/api/guest/${room.token}`);
  assert.equal(info.status, 200);
  assert.equal(info.json.room.number, '101');
  assert.ok(info.json.services.some((s) => s.id === 'room_cleaning'));
  assert.deepEqual(info.json.requests, []);

  // Guest requests room cleaning.
  const created = await call('POST', `/api/guest/${room.token}/requests`, {
    body: {
      service: 'room_cleaning',
      details: { when: 'Within 1 hour', type: 'Full cleaning', bogus: 'dropped' },
      note: 'Please bring extra towels',
    },
  });
  assert.equal(created.status, 201, created.text);
  const reqId = created.json.request.id;
  assert.equal(created.json.request.status, 'new');
  assert.deepEqual(created.json.request.details, { when: 'Within 1 hour', type: 'Full cleaning' });
  assert.equal(created.json.request.handledBy, undefined, 'guest view must not expose staff info');

  // Staff sees it on the dashboard.
  const list = await call('GET', '/api/staff/requests?department=housekeeping', { cookie: admin });
  const onBoard = list.json.requests.find((r) => r.id === reqId);
  assert.ok(onBoard);
  assert.equal(onBoard.roomNumber, '101');
  assert.equal(onBoard.note, 'Please bring extra towels');

  // Staff acknowledges and replies.
  const upd = await call('PATCH', `/api/staff/requests/${reqId}`, {
    cookie: admin,
    body: { status: 'in_progress', staffReply: 'On our way in 10 minutes' },
  });
  assert.equal(upd.status, 200);
  assert.equal(upd.json.request.handledBy, 'Administrator');

  // Guest sees the update.
  const after = await call('GET', `/api/guest/${room.token}`);
  assert.equal(after.json.requests[0].status, 'in_progress');
  assert.equal(after.json.requests[0].staffReply, 'On our way in 10 minutes');

  // In-progress requests can't be cancelled by the guest.
  const cancel = await call('POST', `/api/guest/${room.token}/requests/${reqId}/cancel`);
  assert.equal(cancel.status, 409);
});

test('guest input is validated', async () => {
  const admin = await login('admin', 'admin-pass-123');
  const room = await createRoom(admin, '102');
  const post = (body) => call('POST', `/api/guest/${room.token}/requests`, { body });

  assert.equal((await post({ service: 'nope' })).status, 400);
  assert.equal((await post({ service: 'room_cleaning', details: {} })).status, 400);
  assert.equal((await post({ service: 'room_cleaning', details: { when: 'Hack', type: 'Full cleaning' } })).status, 400);
  assert.equal((await post({ service: 'wake_up_call', details: { time: '25:00', day: 'Today' } })).status, 400);
  assert.equal((await post({ service: 'amenities', details: { items: ['Gold bars'] } })).status, 400);
  assert.equal((await post({ service: 'laundry', details: { service: 'Dry cleaning', speed: 'Express (same day)', pieces: 0 } })).status, 400);

  const ok = await post({ service: 'amenities', details: { items: ['Bath towels', 'Bath towels', 'Soap'], quantity: '2' } });
  assert.equal(ok.status, 201, ok.text);
  assert.deepEqual(ok.json.request.details, { items: ['Bath towels', 'Soap'], quantity: 2 });

  // Guest can cancel while it's still new.
  const cancel = await call('POST', `/api/guest/${room.token}/requests/${ok.json.request.id}/cancel`);
  assert.equal(cancel.status, 200);
  assert.equal(cancel.json.request.status, 'cancelled');
});

test('unknown QR token and cross-room access are rejected', async () => {
  const admin = await login('admin', 'admin-pass-123');
  const a = await createRoom(admin, '201');
  const b = await createRoom(admin, '202');

  assert.equal((await call('GET', '/api/guest/not-a-real-token')).status, 404);

  const created = await call('POST', `/api/guest/${a.token}/requests`, {
    body: { service: 'message', details: { message: 'Hello' } },
  });
  assert.equal(created.status, 201);
  // Room B must not be able to cancel room A's request, nor see it.
  const cross = await call('POST', `/api/guest/${b.token}/requests/${created.json.request.id}/cancel`);
  assert.equal(cross.status, 404);
  const bInfo = await call('GET', `/api/guest/${b.token}`);
  assert.equal(bInfo.json.requests.length, 0);
});

test('rotating the QR token invalidates the old code', async () => {
  const admin = await login('admin', 'admin-pass-123');
  const room = await createRoom(admin, '301');
  assert.equal((await call('POST', `/api/admin/rooms/${room.id}/rotate-token`, { cookie: admin })).status, 200);
  assert.equal((await call('GET', `/api/guest/${room.token}`)).status, 404);

  const qr = await call('GET', `/api/admin/rooms/${room.id}/qr.svg`, { cookie: admin });
  assert.equal(qr.status, 200);
  assert.match(qr.headers.get('content-type'), /svg/);
});

test('checkout resets the room for the next guest', async () => {
  const admin = await login('admin', 'admin-pass-123');
  const room = await createRoom(admin, '401');
  await call('POST', `/api/guest/${room.token}/dnd`, { body: { dnd: true } });
  await call('POST', `/api/guest/${room.token}/requests`, {
    body: { service: 'late_checkout', details: { time: '14:00' } },
  });
  assert.equal((await call('GET', `/api/guest/${room.token}`)).json.room.dnd, true);

  assert.equal((await call('POST', `/api/staff/rooms/${room.id}/checkout`, { cookie: admin })).status, 200);

  const info = await call('GET', `/api/guest/${room.token}`);
  assert.equal(info.json.room.dnd, false);
  assert.equal(info.json.requests.length, 0, 'new guest should not see previous history');
  const open = await call('GET', '/api/staff/requests', { cookie: admin });
  assert.ok(!open.json.requests.some((r) => r.roomNumber === '401'));
});

test('guests are rate limited per room', async () => {
  const admin = await login('admin', 'admin-pass-123');
  const room = await createRoom(admin, '501');
  let last;
  for (let i = 0; i < 16; i++) {
    last = await call('POST', `/api/guest/${room.token}/requests`, {
      body: { service: 'message', details: { message: `msg ${i}` } },
    });
  }
  assert.equal(last.status, 429);
});

test('non-JSON posts are rejected (CSRF guard)', async () => {
  const admin = await login('admin', 'admin-pass-123');
  const res = await fetch(`${base}/api/admin/rooms`, {
    method: 'POST',
    headers: { Cookie: admin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'number=999',
  });
  assert.equal(res.status, 415);
});

test('admin manages staff; staff cannot use admin endpoints', async () => {
  const admin = await login('admin', 'admin-pass-123');
  const add = await call('POST', '/api/admin/staff', {
    cookie: admin,
    body: { name: 'Priya', username: 'Priya', password: 'housekeep1', department: 'housekeeping' },
  });
  assert.equal(add.status, 201, add.text);
  const dup = await call('POST', '/api/admin/staff', {
    cookie: admin,
    body: { name: 'Priya 2', username: 'priya', password: 'housekeep1' },
  });
  assert.equal(dup.status, 409);

  const staff = await login('priya', 'housekeep1');
  assert.equal((await call('GET', '/api/staff/requests', { cookie: staff })).status, 200);
  assert.equal((await call('GET', '/api/admin/rooms', { cookie: staff })).status, 403);
  const me = await call('GET', '/api/auth/me', { cookie: staff });
  assert.equal(me.json.staff.department, 'housekeeping');

  // Logout invalidates the session.
  await call('POST', '/api/auth/logout', { cookie: staff });
  assert.equal((await call('GET', '/api/auth/me', { cookie: staff })).status, 401);
});

test('settings are shown to guests', async () => {
  const admin = await login('admin', 'admin-pass-123');
  const room = await createRoom(admin, '601');
  const res = await call('PUT', '/api/admin/settings', {
    cookie: admin,
    body: { hotel_name: 'Sea View Resort', wifi_name: 'SeaView-Guest', reception_phone: '+911234567890' },
  });
  assert.equal(res.status, 200);
  const info = await call('GET', `/api/guest/${room.token}`);
  assert.equal(info.json.hotel.name, 'Sea View Resort');
  assert.equal(info.json.hotel.wifiName, 'SeaView-Guest');
});

test('staff live stream receives new guest requests', async () => {
  const admin = await login('admin', 'admin-pass-123');
  const room = await createRoom(admin, '701');

  const controller = new AbortController();
  const res = await fetch(`${base}/api/staff/stream`, { headers: { Cookie: admin }, signal: controller.signal });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();

  await call('POST', `/api/guest/${room.token}/requests`, {
    body: { service: 'maintenance', details: { category: 'TV' } },
  });

  let buf = '';
  const decoder = new TextDecoder();
  while (!buf.includes('event: request:new')) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value);
  }
  controller.abort();
  assert.match(buf, /event: request:new/);
  assert.match(buf, /"roomNumber":"701"/);
  assert.doesNotMatch(buf, /guestRequest/);
});
