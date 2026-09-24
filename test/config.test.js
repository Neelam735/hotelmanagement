const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');

const RAILWAY = {
  RAILWAY_ENVIRONMENT: 'production',
  RAILWAY_PUBLIC_DOMAIN: 'hotel-production.up.railway.app',
  RAILWAY_VOLUME_MOUNT_PATH: '/data',
  PORT: '8080',
};

test('local defaults', () => {
  const { port, options, warnings } = loadConfig({});
  assert.equal(port, 3000);
  assert.equal(options.dbFile, path.join(__dirname, '..', 'data', 'hotel.db'));
  assert.equal(options.secureCookies, false);
  assert.equal(options.trustProxy, false);
  assert.equal(options.publicUrl, undefined);
  assert.equal(warnings.length, 1); // PUBLIC_URL hint
});

test('Railway defaults come from the variables Railway sets', () => {
  const { port, options, warnings } = loadConfig(RAILWAY);
  assert.equal(port, 8080);
  assert.equal(options.dbFile, path.join('/data', 'hotel.db'));
  assert.equal(options.publicUrl, 'https://hotel-production.up.railway.app');
  assert.equal(options.secureCookies, true);
  assert.equal(options.trustProxy, 1);
  assert.deepEqual(warnings, []);
});

test('explicit variables override Railway defaults', () => {
  const { options } = loadConfig({
    ...RAILWAY,
    DB_FILE: '/elsewhere/h.db',
    PUBLIC_URL: 'https://rooms.seaview.in',
    SECURE_COOKIES: 'false',
    TRUST_PROXY: '2',
  });
  assert.equal(options.dbFile, '/elsewhere/h.db');
  assert.equal(options.publicUrl, 'https://rooms.seaview.in');
  assert.equal(options.secureCookies, false);
  assert.equal(options.trustProxy, 2);
  assert.equal(loadConfig({ TRUST_PROXY: 'true' }).options.trustProxy, true);
  assert.equal(loadConfig({ TRUST_PROXY: 'loopback' }).options.trustProxy, 'loopback');
});

test('warns when Railway has no volume, since the database would be wiped', () => {
  const { RAILWAY_VOLUME_MOUNT_PATH, ...noVolume } = RAILWAY;
  const { warnings } = loadConfig(noVolume);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ERASED/);
});

test('behind a proxy: health check, https QR links, secure cookies, per-client throttling', async () => {
  const { options } = loadConfig({ ...RAILWAY, RAILWAY_VOLUME_MOUNT_PATH: undefined, DB_FILE: ':memory:', ADMIN_PASSWORD: 'admin-pass-123' });
  const ctx = createApp({ ...options, logger: { log() {}, error() {} } });
  const server = http.createServer(ctx.app);
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.9' },
      body: JSON.stringify({ username: 'admin', password: 'admin-pass-123' }),
    });
    const setCookie = login.headers.get('set-cookie');
    assert.match(setCookie, /; Secure/);
    const cookie = setCookie.split(';')[0];

    await fetch(`${base}/api/admin/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ number: '101' }),
    });
    const rooms = await (await fetch(`${base}/api/admin/rooms`, { headers: { Cookie: cookie } })).json();
    assert.match(rooms.rooms[0].guestUrl, /^https:\/\/hotel-production\.up\.railway\.app\/r\/[\w-]+$/);

    // Failed sign-ins are counted per real client IP (from the proxy header),
    // so one attacker can't lock staff out.
    const attempt = (ip) =>
      fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
        body: JSON.stringify({ username: 'admin', password: 'wrong' }),
      });
    for (let i = 0; i < 10; i++) await attempt('198.51.100.7');
    assert.equal((await attempt('198.51.100.7')).status, 429);
    assert.equal((await attempt('203.0.113.9')).status, 401, 'another client is not blocked');
  } finally {
    ctx.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
