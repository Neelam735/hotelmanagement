(async () => {
  document.getElementById('print').addEventListener('click', () => window.print());
  try {
    const [{ rooms }, { settings }] = await Promise.all([
      api('GET', '/api/admin/rooms'),
      api('GET', '/api/admin/settings'),
    ]);
    document.getElementById('sheet').replaceChildren(
      ...rooms.map((room) =>
        h(
          'div',
          { class: 'qr-card' },
          h('div', { class: 'hotel' }, settings.hotel_name),
          h('div', { class: 'room' }, `Room ${room.number}`),
          h('img', { src: `/api/admin/rooms/${room.id}/qr.svg`, alt: `QR code for room ${room.number}` }),
          h('div', { class: 'cta' }, h('strong', {}, 'Need anything?'), h('br'), 'Scan with your phone camera for housekeeping, laundry, food, taxi & more.')
        )
      )
    );
    if (!rooms.length) document.getElementById('sheet').replaceChildren(h('p', { class: 'muted' }, 'No rooms yet.'));
  } catch (err) {
    if (err.status === 401) location.href = '/login?next=/admin';
    else toast(err.message);
  }
})();
