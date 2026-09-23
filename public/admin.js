(() => {
  const $ = (id) => document.getElementById(id);
  let departments = {};
  let me = null;

  function handleError(err) {
    if (err.status === 401) location.href = '/login?next=/admin';
    else toast(err.message);
  }

  // ---------------------------------------------------------------- rooms
  async function loadRooms() {
    const { rooms } = await api('GET', '/api/admin/rooms');
    $('rooms-body').replaceChildren(
      ...rooms.map((room) =>
        h(
          'tr',
          {},
          h('td', {}, h('strong', {}, room.number)),
          h('td', {}, room.floor || '—'),
          h(
            'td',
            {},
            h('a', { href: `/api/admin/rooms/${room.id}/qr.svg`, target: '_blank', rel: 'noopener' }, 'View QR')
          ),
          h('td', {}, h('a', { href: room.guestUrl, target: '_blank', rel: 'noopener', class: 'small' }, 'Open guest page')),
          h(
            'td',
            { class: 'row' },
            h('button', { type: 'button', class: 'btn-sm', onclick: () => rotate(room), title: 'Use if a QR code was copied or leaked' }, 'New QR'),
            h('button', { type: 'button', class: 'btn-sm btn-danger', onclick: () => removeRoom(room) }, 'Delete')
          )
        )
      )
    );
    if (!rooms.length) {
      $('rooms-body').replaceChildren(h('tr', {}, h('td', { colspan: 5, class: 'muted' }, 'No rooms yet — add your first room above.')));
    }
  }

  async function addRooms(body) {
    try {
      const { created, skipped } = await api('POST', '/api/admin/rooms', body);
      toast(`Added ${created.length} room(s)${skipped.length ? `, skipped ${skipped.length} existing` : ''}`);
      await loadRooms();
      return true;
    } catch (err) {
      handleError(err);
      return false;
    }
  }

  async function rotate(room) {
    if (!confirm(`Generate a new QR code for room ${room.number}?\n\nThe old printed QR code will stop working, so you must print and replace it.`)) return;
    try {
      await api('POST', `/api/admin/rooms/${room.id}/rotate-token`);
      toast(`New QR code created for room ${room.number} — remember to print it`);
      await loadRooms();
    } catch (err) {
      handleError(err);
    }
  }

  async function removeRoom(room) {
    if (!confirm(`Delete room ${room.number} and all of its request history?`)) return;
    try {
      await api('DELETE', `/api/admin/rooms/${room.id}`);
      await loadRooms();
    } catch (err) {
      handleError(err);
    }
  }

  $('room-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (await addRooms({ number: $('room-number').value, floor: $('room-floor').value })) $('room-number').value = '';
  });
  $('range-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const ok = await addRooms({
      from: Number($('range-from').value),
      to: Number($('range-to').value),
      floor: $('range-floor').value,
    });
    if (ok) e.target.reset();
  });

  // ---------------------------------------------------------------- staff
  function renderStaff(staff) {
    $('staff-body').replaceChildren(
      ...staff.map((s) =>
        h(
          'tr',
          {},
          h('td', {}, s.name),
          h('td', {}, s.username),
          h('td', {}, s.role),
          h('td', {}, departments[s.department] || 'All'),
          h(
            'td',
            {},
            s.id === me.id
              ? h('span', { class: 'small muted' }, 'you')
              : h('button', { type: 'button', class: 'btn-sm btn-danger', onclick: () => removeStaff(s) }, 'Remove')
          )
        )
      )
    );
  }

  async function loadStaff() {
    const { staff } = await api('GET', '/api/admin/staff');
    renderStaff(staff);
  }

  async function removeStaff(s) {
    if (!confirm(`Remove ${s.name}? They will no longer be able to sign in.`)) return;
    try {
      const { staff } = await api('DELETE', `/api/admin/staff/${s.id}`);
      renderStaff(staff);
    } catch (err) {
      handleError(err);
    }
  }

  $('staff-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { staff } = await api('POST', '/api/admin/staff', {
        name: $('staff-name').value,
        username: $('staff-username').value,
        password: $('staff-password').value,
        department: $('staff-department').value,
        role: $('staff-role').value,
      });
      renderStaff(staff);
      e.target.reset();
      toast('Staff member added');
    } catch (err) {
      handleError(err);
    }
  });

  // ---------------------------------------------------------------- settings
  const SETTING_KEYS = ['hotel_name', 'welcome_message', 'reception_phone', 'wifi_name', 'wifi_password'];

  async function loadSettings() {
    const { settings } = await api('GET', '/api/admin/settings');
    for (const k of SETTING_KEYS) $(`s-${k}`).value = settings[k] ?? '';
  }

  $('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('PUT', '/api/admin/settings', Object.fromEntries(SETTING_KEYS.map((k) => [k, $(`s-${k}`).value])));
      toast('Settings saved');
    } catch (err) {
      handleError(err);
    }
  });

  $('password-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('POST', '/api/auth/password', { currentPassword: $('pw-current').value, newPassword: $('pw-new').value });
      e.target.reset();
      toast('Password changed');
    } catch (err) {
      handleError(err);
    }
  });

  // ---------------------------------------------------------------- init
  document.querySelectorAll('[data-tab]').forEach((tab) =>
    tab.addEventListener('click', () => {
      document.querySelectorAll('[data-tab]').forEach((t) => {
        t.setAttribute('aria-selected', String(t === tab));
        $(`tab-${t.dataset.tab}`).classList.toggle('hidden', t !== tab);
      });
    })
  );
  $('logout').addEventListener('click', async () => {
    await api('POST', '/api/auth/logout').catch(() => {});
    location.href = '/login';
  });

  (async () => {
    try {
      const [{ staff }, meta] = await Promise.all([api('GET', '/api/auth/me'), api('GET', '/api/meta')]);
      me = staff;
      departments = meta.departments;
      for (const [id, name] of Object.entries(departments)) $('staff-department').append(h('option', { value: id }, name));
      await Promise.all([loadRooms(), loadStaff(), loadSettings()]);
    } catch (err) {
      handleError(err);
    }
  })();
})();
