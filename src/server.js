const { createApp } = require('./app');
const { loadConfig } = require('./config');

const { port, options, warnings } = loadConfig();
for (const warning of warnings) console.warn(`WARNING: ${warning}`);

const { app, close, closeStreams } = createApp(options);

const server = app.listen(port, () => {
  const base = options.publicUrl || `http://localhost:${port}`;
  console.log(`Hotel QR service running on port ${port}`);
  console.log(`  Staff dashboard: ${base}/staff`);
  console.log(`  Admin (rooms & QR codes): ${base}/admin`);
  console.log(`  Database: ${options.dbFile}`);
});

// Hosting platforms (Railway, Docker…) send SIGTERM before replacing the
// container: stop taking requests, end live streams and close the database.
let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} received, shutting down…`);
  // Live-update streams never end on their own; close them so in-flight
  // requests can finish, then close the database.
  closeStreams();
  server.close(() => {
    close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
