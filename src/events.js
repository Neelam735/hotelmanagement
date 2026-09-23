// Tiny Server-Sent Events hub: staff dashboards subscribe to everything,
// guest pages subscribe to their own room only.

function createEventHub() {
  const clients = new Set();

  // filter(type, payload) decides delivery: true to send, false to skip, or
  // 'drop' to end this client's stream (e.g. its access was revoked).
  // view(type, payload) shapes what this client sees (guests get a reduced view).
  function subscribe(req, res, filter, view = (type, payload) => payload) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    const client = {
      res,
      filter,
      view,
      close() {
        clearInterval(ping);
        clients.delete(client);
        res.end();
      },
    };
    clients.add(client);
    req.on('close', () => client.close());
  }

  function publish(type, payload) {
    for (const c of clients) {
      const verdict = c.filter(type, payload);
      if (verdict === 'drop') c.close();
      else if (verdict) c.res.write(`event: ${type}\ndata: ${JSON.stringify(c.view(type, payload))}\n\n`);
    }
  }

  function closeAll() {
    for (const c of clients) c.close();
  }

  return { subscribe, publish, closeAll };
}

module.exports = { createEventHub };
