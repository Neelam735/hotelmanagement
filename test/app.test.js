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

// A guest's phone: keeps its device cookie between calls like a browser
// would, and enters the room code (room.pin) before its first request.
function guestPhone(room) {
  let cookie;
  let verified = false;
  const send = async (method, path = '', body) => {
    const res = await call(method, `/api/guest/${room.token}${path}`, { body, cookie });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return res;
  };
  const phone = async (method, path = '', body) => {
    if (!verified && room.pin) {
      verified = true;
      const res = await send('POST', '/verify', { pin: room.pin });
      assert.equal(res.status, 200, res.text);
    }
    return send(method, path, body);
  };
  phone.send = send; // without entering the code
  phone.cookie = () => cookie;
  return phone;
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

  const guest = guestPhone(room);
  const info = await guest('GET');
  assert.equal(info.status, 200);
  assert.equal(info.json.room.number, '101');
  assert.ok(info.json.services.some((s) => s.id === 'room_cleaning'));
  assert.deepEqual(info.json.requests, []);

  // Guest requests room cleaning.
  const created = await guest('POST', '/requests', {
    service: 'room_cleaning',
    details: { when: 'Within 1 hour', type: 'Full cleaning', time: '10:00', bogus: 'dropped' },
    note: 'Please bring extra towels',
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
  const after = await guest('GET');
  assert.equal(after.json.requests[0].status, 'in_progress');
  assert.equal(after.json.requests[0].staffReply, 'On our way in 10 minutes');

  // In-progress requests can't be cancelled by the guest.
  const cancel = await guest('POST', `/requests/${reqId}/cancel`);
  assert.equal(cancel.status, 409);
});

test('guest input is validated', async () => {
  const admin = await login('admin', 'admin-pass-123');
  const room = await createRoom(admin, '102');
  const guest = guestPhone(room);
  const post = (body) => guest('POST', '/requests', body);

  assert.equal((await post({ service: 'nope' })).status, 400);
  assert.equal((await post({ service: 'room_cleaning', details: {} })).status, 400);
  assert.equal((await post({ service: 'room_cleaning', details: { when: 'Hack', type: 'Full cleaning' } })).status, 400);
  assert.equal((await post({ service: 'wake_up_call', details: { time: '25:00', day: 'Today' } })).status, 400);
  assert.equal((await post({ service: 'amenities', details: { items: ['Gold bars'] } })).status, 400);
  assert.equal((await post({ service: 'laundry', details: { service: 'Dry cleaning', speed: 'Express (same day)', pieces: 0 } })).status, 400);

  // "At a specific time" needs a time; other choices ignore it.
  const specific = { when: 'At a specific time', type: 'Full cleaning' };
  assert.equal((await post({ service: 'room_cleaning', details: specific })).status, 400);
  const timed = await post({ service: 'room_cleaning', details: { ...specific, time: '15:30' } });
  assert.equal(timed.status, 201, timed.text);
  assert.equal(timed.json.request.details.time, '15:30');

  const ok = await post({ service: 'amenities', details: { items: ['Bath towels', 'Bath towels', 'Soap'], quantity: '2' } });
  assert.equal(ok.status, 201, ok.text);
  assert.deepEqual(ok.json.request.details, { items: ['Bath towels', 'Soap'], quantity: 2 });

  // Guest can cancel while it's still new.
  const cancel = await guest('POST', `/requests/${ok.json.request.id}/cancel`);
  assert.equal(cancel.status, 200);
  assert.equal(cancel.json.request.status, 'cancelled');
});

test('unknown QR token and cross-room access are rejected', async () => {
  const admin = await login('admin', 'admin-pass-123');
  const a = await createRoom(admin, '201');
  const b = await createRoom(admin, '202');

  assert.equal((await call('GET', '/api/guest/not-a-real-token')).status, 404);

  const created = await guestPhone(a)('POST', '/requests', { service: 'message', details: { message: 'Hello' } });
  assert.equal(created.status, 201);
  // Room B must not be able to cancel room A's request, nor see it.
  const inB = guestPhone(b);
  const cross = await inB('POST', `/requests/${created.json.request.id}/cancel`);
  assert.equal(cross.status, 404);
  const bInfo = await inB('GET');
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
  const guest = guestPhone(room);
  await guest('POST', '/dnd', { dnd: true });
  await guest('POST', '/requests', { service: 'late_checkout', details: { time: '14:00' } });
  assert.equal((await guest('GET')).json.room.dnd, true);

  const controller = new AbortController();
  const stream = await fetch(`${base}/api/guest/${room.token}/stream`, {
    headers: { Cookie: guest.cookie() },
    signal: controller.signal,
  });
  assert.equal(stream.status, 200);

  assert.equal((await call('POST', `/api/staff/rooms/${room.id}/checkout`, { cookie: admin })).status, 200);

  // The previous guest's open page is disconnected at checkout.
  const rest = await readStream(stream.body.getReader(), () => false);
  controller.abort();
  assert.equal(rest.ended, true);

  // The old phone is signed out: it has to enter the new code.
  const info = await guest('GET');
  assert.equal(info.json.locked, true);
  assert.equal(info.json.requests, undefined, 'previous guest must not see anything');
  assert.equal((await guest('POST', '/dnd', { dnd: true })).status, 403);

  const next = guestPhone(room);
  room.pin = (await call('GET', '/api/staff/rooms', { cookie: admin })).json.rooms.find((r) => r.id === room.id).pin;
  const fresh = await next('GET');
  assert.equal(fresh.json.room.dnd, false);
  assert.equal(fresh.json.requests.length, 0);
  const open = await call('GET', '/api/staff/requests', { cookie: admin });
  assert.ok(!open.json.requests.some((r) => r.roomNumber === '401'));
});

test('guests are rate limited per phone and per room', async () => {
  const admin = await login('admin', 'admin-pass-123');
  const room = await createRoom(admin, '501');
  const send = (phone, i) => phone('POST', '/requests', { service: 'message', details: { message: `msg ${i}` } });

  // One phone can't keep more than 10 requests open...
  const spammer = guestPhone(room);
  let last;
  for (let i = 0; i < 11; i++) last = await send(spammer, i);
  assert.equal(last.status, 429);

  // ...so the real guest on another phone can still ask for help.
  assert.equal((await send(guestPhone(room), 'real')).status, 201);

  // The room as a whole is capped per hour.
  for (let i = 0; i < 25; i++) last = await send(guestPhone(room), `p${i}`);
  assert.equal(last.status, 429);
});

test('a previous guest cannot see or cancel the next guest\'s requests', async () => {
  const admin = await login('admin', 'admin-pass-123');
  const room = await createRoom(admin, '502');
  const previousGuest = guestPhone(room);
  await previousGuest('POST', '/requests', { service: 'message', details: { message: 'old stay' } });

  const checkout = await call('POST', `/api/staff/rooms/${room.id}/checkout`, { cookie: admin });
  assert.match(checkout.json.pin, /^\d{4}$/);
  const nextGuest = guestPhone({ ...room, pin: checkout.json.pin });
  const mine = await nextGuest('POST', '/requests', {
    service: 'room_service',
    details: { order: 'Private dinner order' },
  });
  assert.equal(mine.status, 201);

  // Same QR link, old phone: locked out of the new stay.
  const peek = await previousGuest('GET');
  assert.equal(peek.json.locked, true);
  assert.equal(peek.json.requests, undefined);
  assert.equal((await previousGuest('POST', `/requests/${mine.json.request.id}/cancel`)).status, 403);
  // The old code no longer works (unless the new one happens to be identical).
  if (checkout.json.pin !== room.pin) {
    assert.equal((await guestPhone(room).send('POST', '/verify', { pin: room.pin })).status, 400);
  }

  // A second phone of the new guest sees only its own requests.
  const secondPhone = guestPhone({ ...room, pin: checkout.json.pin });
  assert.deepEqual((await secondPhone('GET')).json.requests, []);

  // The new guest sees only their own request.
  const own = await nextGuest('GET');
  assert.deepEqual(
    own.json.requests.map((r) => r.id),
    [mine.json.request.id]
  );
});

// Reads an SSE response until `until(text)` is true, the stream ends, or timeout.
async function readStream(reader, until, timeoutMs = 2000) {
  const decoder = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + timeoutMs;
  while (!until(buf)) {
    const next = await Promise.race([
      reader.read(),
      new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), Math.max(0, deadline - Date.now()))),
    ]);
    if (next.timeout) return { buf, ended: false };
    if (next.done) return { buf, ended: true };
    buf += decoder.decode(next.value);
  }
  return { buf, ended: false };
}

test('guest live stream only carries this phone\'s requests and ends when the QR is replaced', async () => {
  const admin = await login('admin', 'admin-pass-123');
  const room = await createRoom(admin, '503');
  const myPhone = guestPhone(room);
  await myPhone('GET');
  const myCookie = myPhone.cookie();
  const otherPhone = guestPhone(room);

  const controller = new AbortController();
  const res = await fetch(`${base}/api/guest/${room.token}/stream`, {
    headers: { Cookie: myCookie },
    signal: controller.signal,
  });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();

  await otherPhone('POST', '/requests', { service: 'message', details: { message: 'from other phone' } });
  await call('POST', `/api/guest/${room.token}/requests`, {
    cookie: myCookie,
    body: { service: 'message', details: { message: 'from my phone' } },
  });
  const first = await readStream(reader, (b) => b.includes('from my phone'));
  assert.match(first.buf, /from my phone/);
  assert.doesNotMatch(first.buf, /from other phone/);

  // Replace the QR code; the next event for the room closes the old link's stream.
  await call('POST', `/api/admin/rooms/${room.id}/rotate-token`, { cookie: admin });
  const fresh = (await call('GET', '/api/admin/rooms', { cookie: admin })).json.rooms.find((r) => r.id === room.id);
  await guestPhone({ token: fresh.guestUrl.split('/r/')[1], pin: fresh.pin })('POST', '/dnd', { dnd: true });
  const rest = await readStream(reader, () => false);
  controller.abort();
  assert.equal(rest.ended, true, 'old stream should be closed');
  assert.doesNotMatch(rest.buf, /room:update/);
});

test('staff sign-in is throttled after repeated failures', async () => {
  const body = { username: 'throttle-me', password: 'wrong' };
  for (let i = 0; i < 10; i++) assert.equal((await call('POST', '/api/auth/login', { body })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { body })).status, 429);
});

test('changing password signs out other sessions and ends their live stream', async () => {
  const admin = await login('admin', 'admin-pass-123');
  await call('POST', '/api/admin/staff', {
    cookie: admin,
    body: { name: 'Ravi', username: 'ravi', password: 'frontdesk1', department: 'front_desk' },
  });
  const laptop = await login('ravi', 'frontdesk1');
  const phone = await login('ravi', 'frontdesk1');

  const controller = new AbortController();
  const res = await fetch(`${base}/api/staff/stream`, { headers: { Cookie: phone }, signal: controller.signal });
  const reader = res.body.getReader();

  const change = await call('POST', '/api/auth/password', {
    cookie: laptop,
    body: { currentPassword: 'frontdesk1', newPassword: 'frontdesk2' },
  });
  assert.equal(change.status, 200);
  assert.equal((await call('GET', '/api/auth/me', { cookie: laptop })).status, 200);
  assert.equal((await call('GET', '/api/auth/me', { cookie: phone })).status, 401);

  // The signed-out phone's stream is closed at the next event instead of leaking it.
  const room = await createRoom(admin, '801');
  await guestPhone(room)('POST', '/requests', { service: 'message', details: { message: 'secret' } });
  const rest = await readStream(reader, () => false);
  controller.abort();
  assert.equal(rest.ended, true);
  assert.doesNotMatch(rest.buf, /secret/);
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
  const info = await guestPhone(room)('GET');
  assert.equal(info.json.hotel.name, 'Sea View Resort');
  assert.equal(info.json.hotel.wifiName, 'SeaView-Guest');
  // Before entering the room code, only the hotel name and reception number show.
  const locked = await guestPhone(room).send('GET');
  assert.equal(locked.json.locked, true);
  assert.equal(locked.json.hotel.name, 'Sea View Resort');
  assert.equal(locked.json.hotel.wifiName, undefined);
});

test('staff live stream receives new guest requests', async () => {
  const admin = await login('admin', 'admin-pass-123');
  const room = await createRoom(admin, '701');

  const controller = new AbortController();
  const res = await fetch(`${base}/api/staff/stream`, { headers: { Cookie: admin }, signal: controller.signal });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();

  await guestPhone(room)('POST', '/requests', { service: 'maintenance', details: { category: 'TV' } });

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

// ---------------------------------------------------------------- due times

// Hotel-local wall-clock parts of an instant.
function localParts(iso, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(iso));
  const get = (t) => parts.find((p) => p.type === t).value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
}

test('scheduled requests get a due time in the hotel time zone', async () => {
  const admin = await login('admin', 'admin-pass-123');
  const tz = 'Asia/Kolkata';
  assert.equal((await call('PUT', '/api/admin/settings', { cookie: admin, body: { timezone: tz } })).status, 200);
  const room = await createRoom(admin, '901');
  const guest = guestPhone(room);

  const wake = await guest('POST', '/requests', { service: 'wake_up_call', details: { time: '06:00', day: 'Tomorrow' } });
  assert.equal(wake.status, 201, wake.text);
  const tomorrow = localParts(new Date(Date.now() + 864e5).toISOString(), tz).date;
  assert.deepEqual(localParts(wake.json.request.dueAt, tz), { date: tomorrow, time: '06:00' });

  // Staff get reminded 5 minutes before and it's overdue 15 minutes after.
  const staffView = (await call('GET', '/api/staff/requests', { cookie: admin })).json.requests.find(
    (r) => r.id === wake.json.request.id
  );
  const due = Date.parse(staffView.dueAt);
  assert.equal(Date.parse(staffView.remindAt), due - 5 * 60000);
  assert.equal(Date.parse(staffView.overdueAt), due + 15 * 60000);
  assert.match(staffView.summary, /Wake-up time: 06:00/);

  // A taxi now needs a day, and "Today" at a time that has passed is refused.
  assert.equal((await guest('POST', '/requests', { service: 'transport', details: { type: 'Taxi', time: '09:00' } })).status, 400);
  const now = localParts(new Date().toISOString(), tz).time;
  const [hh, mm] = now.split(':').map(Number);
  if (hh >= 1) {
    const past = `${String(hh - 1).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    const late = await guest('POST', '/requests', { service: 'wake_up_call', details: { time: past, day: 'Today' } });
    assert.equal(late.status, 400);
    assert.match(late.json.error, /already passed/);
  }

  // Services without a time have no due time.
  const towels = await guest('POST', '/requests', { service: 'amenities', details: { items: ['Soap'] } });
  assert.equal(towels.json.request.dueAt, null);
});

test('unscheduled requests become overdue after the configured minutes', async () => {
  const admin = await login('admin', 'admin-pass-123');
  assert.equal((await call('PUT', '/api/admin/settings', { cookie: admin, body: { overdue_minutes: '3' } })).status, 200);
  const room = await createRoom(admin, '902');
  const created = await guestPhone(room)('POST', '/requests', { service: 'amenities', details: { items: ['Soap'] } });
  const r = (await call('GET', '/api/staff/requests', { cookie: admin })).json.requests.find(
    (x) => x.id === created.json.request.id
  );
  assert.equal(r.remindAt, null);
  assert.equal(Date.parse(r.overdueAt), Date.parse(r.createdAt) + 3 * 60000);

  // Bad settings are refused and nothing is saved.
  for (const body of [{ timezone: 'Mars/Base' }, { overdue_minutes: '0' }, { currency: 'ABC' }, { require_pin: 'maybe' }]) {
    assert.equal((await call('PUT', '/api/admin/settings', { cookie: admin, body })).status, 400, JSON.stringify(body));
  }
  assert.equal((await call('PUT', '/api/admin/settings', { cookie: admin, body: { overdue_minutes: '10' } })).status, 200);
});

// ---------------------------------------------------------------- stay PIN

test('the room code is required, rate limited and can be reissued', async () => {
  const admin = await login('admin', 'admin-pass-123');
  const room = await createRoom(admin, '911');
  assert.match(room.pin, /^\d{4}$/);

  const stranger = guestPhone(room);
  assert.equal((await stranger.send('POST', '/requests', { service: 'message', details: { message: 'hi' } })).status, 403);
  assert.equal((await stranger.send('GET', '/stream')).status, 403);

  const wrong = room.pin === '0000' ? '1111' : '0000';
  assert.equal((await stranger.send('POST', '/verify', { pin: wrong })).status, 400);
  assert.equal((await stranger.send('POST', '/verify', { pin: 'abcd' })).status, 400);

  // The real guest signs in; then a new code is issued (e.g. it was overheard).
  const guest = guestPhone(room);
  assert.equal((await guest('GET')).json.locked, undefined);
  const reissued = await call('POST', `/api/staff/rooms/${room.id}/new-pin`, { cookie: admin });
  assert.equal(reissued.status, 200);
  // Already signed-in phones keep working; the old code no longer does.
  assert.equal((await guest('POST', '/dnd', { dnd: true })).status, 200);
  let failures = 0; // reissuing the code reset the counter
  if (reissued.json.pin !== room.pin) {
    assert.equal((await guestPhone(room).send('POST', '/verify', { pin: room.pin })).status, 400);
    failures++;
  }

  // Guessing is limited per room: after 10 wrong tries even the right code waits.
  const newPinValue = reissued.json.pin;
  const bad = newPinValue === '0000' ? '1111' : '0000';
  let res;
  for (; failures < 10; failures++) res = await guestPhone(room).send('POST', '/verify', { pin: bad });
  assert.equal(res.status, 400);
  assert.equal((await guestPhone(room).send('POST', '/verify', { pin: newPinValue })).status, 429);
  // Reception can unblock the guest by issuing a fresh code.
  const unblock = await call('POST', `/api/staff/rooms/${room.id}/new-pin`, { cookie: admin });
  assert.equal((await guestPhone({ ...room, pin: unblock.json.pin })('GET')).status, 200);
});

test('the room code can be switched off', async () => {
  const admin = await login('admin', 'admin-pass-123');
  const room = await createRoom(admin, '912');
  await call('PUT', '/api/admin/settings', { cookie: admin, body: { require_pin: 'false' } });
  try {
    const open = guestPhone({ token: room.token }); // no code entered
    assert.equal((await open('GET')).json.locked, undefined);
    assert.equal((await open('POST', '/requests', { service: 'message', details: { message: 'hi' } })).status, 201);
  } finally {
    await call('PUT', '/api/admin/settings', { cookie: admin, body: { require_pin: 'true' } });
  }
  assert.equal((await guestPhone({ token: room.token })('GET')).json.locked, true);
});

// ---------------------------------------------------------------- food menu

test('guests order from the menu and the kitchen sees items and total', async () => {
  const admin = await login('admin', 'admin-pass-123');
  const add = (item) => call('POST', '/api/admin/menu', { cookie: admin, body: item });

  assert.equal((await add({ category: '', name: 'X', price: 10 })).status, 400);
  assert.equal((await add({ category: 'Mains', name: 'X', price: -1 })).status, 400);

  const paneer = (await add({ category: 'Mains', name: 'Paneer Tikka', price: 249.5, veg: true })).json.item;
  const chai = (await add({ category: 'Drinks', name: 'Masala Chai', price: 60, veg: true })).json.item;
  const hidden = (await add({ category: 'Mains', name: 'Seasonal Special', price: 500, available: false })).json.item;
  assert.equal(paneer.price, 24950);

  // Staff (non-admin) can't edit the menu.
  await call('POST', '/api/admin/staff', {
    cookie: admin,
    body: { name: 'Chef', username: 'chef', password: 'kitchen123', department: 'kitchen' },
  });
  const chef = await login('chef', 'kitchen123');
  assert.equal((await call('POST', '/api/admin/menu', { cookie: chef, body: { category: 'A', name: 'B', price: 1 } })).status, 403);

  const room = await createRoom(admin, '921');
  const guest = guestPhone(room);
  const page = await guest('GET');
  const names = page.json.menu.map((m) => m.name);
  assert.ok(names.includes('Paneer Tikka') && names.includes('Masala Chai'));
  assert.ok(!names.includes('Seasonal Special'), 'unavailable items are hidden');
  assert.equal(page.json.hotel.currency, 'INR');

  const order = (items, extra = {}) =>
    guest('POST', '/requests', { service: 'room_service', details: { items, ...extra } });

  assert.equal((await order([{ id: hidden.id, qty: 1 }])).status, 400);
  assert.equal((await order([{ id: paneer.id, qty: 0 }])).status, 400);
  assert.equal((await order([{ id: paneer.id, qty: 21 }])).status, 400);
  assert.equal((await order([{ id: 999999, qty: 1 }])).status, 400);
  assert.equal((await guest('POST', '/requests', { service: 'room_service', details: {} })).status, 400);

  const placed = await order(
    [
      { id: paneer.id, qty: 2 },
      { id: chai.id, qty: 1 },
      { id: chai.id, qty: 1 },
    ],
    { order: 'Extra napkins' }
  );
  assert.equal(placed.status, 201, placed.text);
  assert.deepEqual(placed.json.request.details.items, [
    { id: paneer.id, name: 'Paneer Tikka', qty: 2, price: 24950 },
    { id: chai.id, name: 'Masala Chai', qty: 2, price: 6000 },
  ]);
  assert.equal(placed.json.request.details.total, 2 * 24950 + 2 * 6000);

  const kitchen = await call('GET', '/api/staff/requests?department=kitchen', { cookie: chef });
  const ticket = kitchen.json.requests.find((r) => r.id === placed.json.request.id);
  assert.match(ticket.summary, /2× Paneer Tikka, 2× Masala Chai \(₹619\)/);
  assert.match(ticket.summary, /Extra napkins/);

  // Later price changes don't rewrite past orders.
  await call('PUT', `/api/admin/menu/${paneer.id}`, {
    cookie: admin,
    body: { category: 'Mains', name: 'Paneer Tikka', price: 299, veg: true, available: true },
  });
  const again = (await guest('GET')).json.requests.find((r) => r.id === placed.json.request.id);
  assert.equal(again.details.total, 61900);

  assert.equal((await call('DELETE', `/api/admin/menu/${hidden.id}`, { cookie: admin })).status, 200);
  assert.equal((await call('DELETE', `/api/admin/menu/${hidden.id}`, { cookie: admin })).status, 404);
});
