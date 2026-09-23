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
  const SETTING_KEYS = [
    'hotel_name',
    'welcome_message',
    'reception_phone',
    'wifi_name',
    'wifi_password',
    'timezone',
    'overdue_minutes',
    'currency',
  ];

  // Browsers list some zones under outdated names; show the current ones.
  const MODERN_ZONE_NAMES = {
    'Asia/Calcutta': 'Asia/Kolkata',
    'Asia/Katmandu': 'Asia/Kathmandu',
    'Asia/Rangoon': 'Asia/Yangon',
    'Asia/Saigon': 'Asia/Ho_Chi_Minh',
    'Europe/Kiev': 'Europe/Kyiv',
    'Atlantic/Faeroe': 'Atlantic/Faroe',
    'America/Buenos_Aires': 'America/Argentina/Buenos_Aires',
  };
  const modernZone = (z) => MODERN_ZONE_NAMES[z] || z;

  async function loadSettings() {
    const { settings } = await api('GET', '/api/admin/settings');
    const zones = [...new Set((Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : []).map(modernZone))].sort();
    if (!zones.includes(settings.timezone)) zones.unshift(settings.timezone);
    $('s-timezone').replaceChildren(...zones.map((z) => h('option', { value: z }, z.replaceAll('_', ' '))));

    // Servers often run on UTC; point it out if this device is somewhere else.
    const here = modernZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
    $('tz-hint').replaceChildren(
      ...(here && modernZone(settings.timezone) !== here
        ? [
            `This device is set to ${here.replaceAll('_', ' ')}. `,
            h('button', { type: 'button', class: 'btn-sm', onclick: () => ($('s-timezone').value = here) }, `Use ${here.replaceAll('_', ' ')}`),
          ]
        : [])
    );
    for (const k of SETTING_KEYS) $(`s-${k}`).value = settings[k] ?? '';
    $('s-require_pin').checked = settings.require_pin === 'true';
    currency = settings.currency;
  }

  $('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const body = Object.fromEntries(SETTING_KEYS.map((k) => [k, $(`s-${k}`).value]));
      body.currency = body.currency.toUpperCase();
      body.require_pin = String($('s-require_pin').checked);
      await api('PUT', '/api/admin/settings', body);
      await Promise.all([loadSettings(), loadMenu()]);
      toast('Settings saved');
    } catch (err) {
      handleError(err);
    }
  });

  // ---------------------------------------------------------------- menu
  let currency = 'INR';
  let editingItem = null;

  function resetMenuForm() {
    editingItem = null;
    $('menu-form').reset();
    $('menu-form-title').textContent = 'Add menu item';
    $('menu-submit').textContent = 'Add item';
    $('menu-cancel-edit').classList.add('hidden');
  }

  function editMenuItem(item) {
    editingItem = item;
    $('m-category').value = item.category;
    $('m-name').value = item.name;
    $('m-price').value = (item.price / 100).toString();
    $('m-description').value = item.description;
    $('m-veg').value = item.veg === null ? '' : item.veg ? 'veg' : 'nonveg';
    $('menu-form-title').textContent = `Edit “${item.name}”`;
    $('menu-submit').textContent = 'Save changes';
    $('menu-cancel-edit').classList.remove('hidden');
    $('menu-form').scrollIntoView({ behavior: 'smooth' });
  }

  function menuPayload(item) {
    return {
      category: item.category,
      name: item.name,
      description: item.description,
      price: item.price / 100,
      veg: item.veg,
      available: item.available,
    };
  }

  async function loadMenu() {
    const { menu } = await api('GET', '/api/admin/menu');
    $('m-categories').replaceChildren(...[...new Set(menu.map((m) => m.category))].map((c) => h('option', { value: c })));
    $('menu-body').replaceChildren(
      ...menu.map((item) =>
        h(
          'tr',
          {},
          h(
            'td',
            {},
            item.veg === null ? null : h('span', { class: `veg-dot ${item.veg ? 'veg' : 'nonveg'}` }),
            h('strong', {}, item.name),
            item.description ? h('div', { class: 'small muted' }, item.description) : null
          ),
          h('td', {}, item.category),
          h('td', {}, formatMoney(item.price, currency)),
          h(
            'td',
            {},
            h(
              'label',
              { class: 'check-row' },
              h('input', {
                type: 'checkbox',
                checked: item.available,
                'aria-label': `${item.name} available`,
                onchange: (e) => saveMenuItem(item, { ...menuPayload(item), available: e.target.checked }),
              }),
              h('span', { class: 'small' }, item.available ? 'On menu' : 'Hidden')
            )
          ),
          h(
            'td',
            { class: 'row' },
            h('button', { type: 'button', class: 'btn-sm', onclick: () => editMenuItem(item) }, 'Edit'),
            h('button', { type: 'button', class: 'btn-sm btn-danger', onclick: () => removeMenuItem(item) }, 'Delete')
          )
        )
      )
    );
    if (!menu.length) {
      $('menu-body').replaceChildren(h('tr', {}, h('td', { colspan: 5, class: 'muted' }, 'No menu items yet.')));
    }
  }

  async function saveMenuItem(item, payload) {
    try {
      if (item) await api('PUT', `/api/admin/menu/${item.id}`, payload);
      else await api('POST', '/api/admin/menu', payload);
      await loadMenu();
      return true;
    } catch (err) {
      handleError(err);
      await loadMenu();
      return false;
    }
  }

  async function removeMenuItem(item) {
    if (!confirm(`Delete “${item.name}” from the menu? (To hide it for today, untick Available instead.)`)) return;
    try {
      await api('DELETE', `/api/admin/menu/${item.id}`);
      if (editingItem?.id === item.id) resetMenuForm();
      await loadMenu();
    } catch (err) {
      handleError(err);
    }
  }

  $('menu-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const veg = $('m-veg').value;
    const payload = {
      category: $('m-category').value,
      name: $('m-name').value,
      description: $('m-description').value,
      price: Number($('m-price').value),
      veg: veg === '' ? null : veg === 'veg',
      available: editingItem ? editingItem.available : true,
    };
    const wasEditing = Boolean(editingItem);
    if (await saveMenuItem(editingItem, payload)) {
      const category = payload.category;
      resetMenuForm();
      if (!wasEditing) $('m-category').value = category; // quicker to add several items in a row
      toast(wasEditing ? 'Menu item updated' : 'Menu item added');
      $(wasEditing ? 'm-category' : 'm-name').focus();
    }
  });
  $('menu-cancel-edit').addEventListener('click', resetMenuForm);

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
      await loadMenu();
    } catch (err) {
      handleError(err);
    }
  })();
})();
