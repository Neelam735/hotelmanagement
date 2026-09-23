const path = require('node:path');
const { createApp } = require('./app');

const port = Number(process.env.PORT) || 3000;

const { app } = createApp({
  dbFile: process.env.DB_FILE || path.join(__dirname, '..', 'data', 'hotel.db'),
  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD,
  publicUrl: process.env.PUBLIC_URL,
  secureCookies: process.env.SECURE_COOKIES === 'true',
  trustProxy: process.env.TRUST_PROXY || false,
});

app.listen(port, () => {
  console.log(`Hotel QR service running on http://localhost:${port}`);
  console.log(`  Staff dashboard: http://localhost:${port}/staff`);
  console.log(`  Admin (rooms & QR codes): http://localhost:${port}/admin`);
});
