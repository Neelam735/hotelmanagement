const path = require('node:path');

// Express reads a string as a list of IP addresses, so "1" must become the
// number of proxy hops and "true"/"false" booleans.
function parseTrustProxy(value) {
  if (value === undefined || value === '') return undefined;
  if (/^\d+$/.test(value)) return Number(value);
  if (value === 'true' || value === 'false') return value === 'true';
  return value; // e.g. "loopback, 10.0.0.0/8"
}

// Builds createApp() options from environment variables. On Railway it picks
// sensible defaults from the variables Railway sets itself, so a deploy only
// needs a volume and an admin password.
function loadConfig(env = process.env) {
  const onRailway = Boolean(env.RAILWAY_ENVIRONMENT || env.RAILWAY_PROJECT_ID);
  const bool = (value, fallback) => (value === undefined || value === '' ? fallback : value === 'true');

  // A Railway volume survives redeploys; the container's own disk does not.
  const defaultDbFile = env.RAILWAY_VOLUME_MOUNT_PATH
    ? path.join(env.RAILWAY_VOLUME_MOUNT_PATH, 'hotel.db')
    : path.join(__dirname, '..', 'data', 'hotel.db');

  // The address printed in QR codes. Railway serves apps over HTTPS on this domain.
  const publicUrl = env.PUBLIC_URL || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : undefined);

  return {
    port: Number(env.PORT) || 3000,
    options: {
      dbFile: env.DB_FILE || defaultDbFile,
      adminUsername: env.ADMIN_USERNAME || 'admin',
      adminPassword: env.ADMIN_PASSWORD,
      publicUrl,
      secureCookies: bool(env.SECURE_COOKIES, onRailway),
      // Railway's proxy sits in front of the app: trust one hop so client IPs
      // (used for sign-in throttling) and https are seen correctly.
      trustProxy: parseTrustProxy(env.TRUST_PROXY) ?? (onRailway ? 1 : false),
    },
    warnings: [
      onRailway && !env.RAILWAY_VOLUME_MOUNT_PATH && !env.DB_FILE
        ? 'No Railway volume attached: the database will be ERASED on every deploy. Attach a volume (see README).'
        : null,
      !publicUrl ? 'PUBLIC_URL is not set: QR codes will use whatever address the admin page was opened with.' : null,
    ].filter(Boolean),
  };
}

module.exports = { loadConfig };
