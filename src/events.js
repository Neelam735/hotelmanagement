// Tiny Server-Sent Events hub: staff dashboards subscribe to everything,
// guest pages subscribe to their own room only.

function createEventHub() {
  const clients = new Set();

  // filter(type, payload) decides delivery; view(type, payload) shapes what this
  // client sees (guests get a reduced view).
  function subscribe(req, res, filter, view = (type, payload) => payload) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const client = { res, filter, view };
    clients.add(client);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(client);
    });
  }

  function publish(type, payload) {
    for (const c of clients) {
      if (c.filter(type, payload)) {
        c.res.write(`event: ${type}\ndata: ${JSON.stringify(c.view(type, payload))}\n\n`);
      }
    }
  }

  function closeAll() {
    for (const c of clients) c.res.end();
    clients.clear();
  }

  return { subscribe, publish, closeAll };
}

module.exports = { createEventHub };
