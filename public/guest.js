(() => {
  const token = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '');
  const base = `/api/guest/${encodeURIComponent(token)}`;

  const state = { hotel: {}, services: [], menu: [], requests: [], current: null, cart: new Map(), stream: null };
  const $ = (id) => document.getElementById(id);
  const MAIN_CARDS = ['services-card', 'requests-card', 'room-card'];

  function show(ids, visible) {
    for (const id of ids) $(id).classList.toggle('hidden', !visible);
  }

  function showError(message) {
    $('error-text').textContent = message;
    $('error').classList.remove('hidden');
    show([...MAIN_CARDS, 'info-card', 'pin-card'], false);
  }

  function renderHeader(hotel, room) {
    document.title = `${hotel.name} · Room ${room.number}`;
    $('hotel-name').textContent = hotel.name;
    $('room-label').textContent = `Room ${room.number}`;
    $('welcome').textContent = hotel.welcomeMessage;
  }

  function renderInfo(hotel) {
    const info = [];
    if (hotel.wifiName) info.push(['Wi-Fi network', hotel.wifiName]);
    if (hotel.wifiPassword) info.push(['Wi-Fi password', hotel.wifiPassword]);
    if (hotel.receptionPhone) {
      info.push(['Reception (emergencies)', h('a', { href: `tel:${hotel.receptionPhone}` }, hotel.receptionPhone)]);
    }
    $('info').replaceChildren(...info.map(([k, v]) => h('div', {}, h('span', { class: 'muted' }, k), h('strong', {}, v))));
    $('info-card').classList.toggle('hidden', !info.length);
  }

  // ---------------------------------------------------------------- room code
  function showPinScreen(hotel) {
    show(MAIN_CARDS, false);
    $('pin-card').classList.remove('hidden');
    $('pin-help').replaceChildren(
      "Don't have a code? ",
      hotel.receptionPhone ? h('a', { href: `tel:${hotel.receptionPhone}` }, 'Call reception') : 'Please ask reception',
      '.'
    );
    renderInfo(hotel);
    $('pin').focus();
  }

  $('pin-card').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('pin-error').classList.add('hidden');
    try {
      await api('POST', `${base}/verify`, { pin: $('pin').value });
      $('pin').value = '';
      $('pin-card').classList.add('hidden');
      await start();
    } catch (err) {
      $('pin-error').textContent = err.message;
      $('pin-error').classList.remove('hidden');
    }
  });

  // ---------------------------------------------------------------- services
  function renderServices() {
    $('services').replaceChildren(
      ...state.services.map((s) =>
        h(
          'button',
          { type: 'button', class: 'service-tile', onclick: () => openDialog(s) },
          h('span', { class: 'icon', 'aria-hidden': 'true' }, s.icon),
          s.name
        )
      )
    );
  }

  function renderRequests() {
    if (!state.requests.length) {
      $('requests').replaceChildren(h('p', { class: 'muted' }, 'No requests yet. Tap a service above to get started.'));
      return;
    }
    $('requests').replaceChildren(
      ...state.requests.map((r) =>
        h(
          'div',
          { class: 'request-item' },
          h('span', { class: 'icon', 'aria-hidden': 'true' }, r.icon),
          h(
            'div',
            { class: 'body' },
            h('div', { class: 'row' }, h('strong', {}, r.serviceName), statusPill(r.status)),
            r.dueAt ? h('div', { class: 'small due-line' }, `⏰ Scheduled for ${formatDue(r.dueAt, state.hotel.timezone)}`) : null,
            r.summary ? h('div', { class: 'small muted' }, r.summary) : null,
            r.note ? h('div', { class: 'small' }, `Note: ${r.note}`) : null,
            r.staffReply ? h('div', { class: 'reply small' }, h('strong', {}, 'Reception: '), r.staffReply) : null,
            h('div', { class: 'small muted' }, timeAgo(r.createdAt))
          ),
          ['new', 'acknowledged'].includes(r.status)
            ? h('button', { type: 'button', class: 'btn-sm btn-danger', onclick: () => cancelRequest(r) }, 'Cancel')
            : null
        )
      )
    );
  }

  // ---------------------------------------------------------------- menu cart
  function cartTotals() {
    let count = 0;
    let total = 0;
    for (const item of state.menu) {
      const qty = state.cart.get(item.id) || 0;
      count += qty;
      total += qty * item.price;
    }
    return { count, total };
  }

  function updateCartBar() {
    const bar = $('dialog-fields').querySelector('.cart-bar');
    if (!bar) return;
    const { count, total } = cartTotals();
    const money = formatMoney(total, state.hotel.currency);
    bar.textContent = count ? `${count} item${count > 1 ? 's' : ''} · ${money}` : 'Your cart is empty';
    $('dialog-submit').textContent = count ? `Place order · ${money}` : 'Place order';
  }

  function renderCart() {
    const byCategory = new Map();
    for (const item of state.menu) {
      if (!byCategory.has(item.category)) byCategory.set(item.category, []);
      byCategory.get(item.category).push(item);
    }
    const stepper = (item) => {
      const qtyEl = h('span', { class: 'qty', 'aria-live': 'polite' }, state.cart.get(item.id) || 0);
      const change = (delta) => {
        const qty = Math.max(0, Math.min(20, (state.cart.get(item.id) || 0) + delta));
        if (qty) state.cart.set(item.id, qty);
        else state.cart.delete(item.id);
        qtyEl.textContent = qty;
        updateCartBar();
      };
      return h(
        'div',
        { class: 'stepper' },
        h('button', { type: 'button', class: 'btn-sm', 'aria-label': `Remove one ${item.name}`, onclick: () => change(-1) }, '−'),
        qtyEl,
        h('button', { type: 'button', class: 'btn-sm', 'aria-label': `Add one ${item.name}`, onclick: () => change(1) }, '+')
      );
    };
    return h(
      'div',
      { class: 'field menu' },
      [...byCategory].map(([category, items]) => [
        h('h3', { class: 'menu-category' }, category),
        items.map((item) =>
          h(
            'div',
            { class: 'menu-item' },
            h(
              'div',
              { class: 'menu-text' },
              h(
                'div',
                {},
                item.veg === null
                  ? null
                  : h('span', { class: `veg-dot ${item.veg ? 'veg' : 'nonveg'}`, title: item.veg ? 'Vegetarian' : 'Non-vegetarian' }),
                h('strong', {}, item.name)
              ),
              item.description ? h('div', { class: 'small muted' }, item.description) : null,
              h('div', { class: 'small' }, formatMoney(item.price, state.hotel.currency))
            ),
            stepper(item)
          )
        ),
      ]),
      h('div', { class: 'cart-bar', role: 'status' })
    );
  }

  // ---------------------------------------------------------------- request form
  function renderField(f) {
    if (f.type === 'cart') return state.menu.length ? renderCart() : null;
    const id = `f-${f.name}`;
    const label = !state.menu.length && f.labelWithoutMenu ? f.labelWithoutMenu : f.label;
    let input;
    if (f.type === 'select') {
      input = h(
        'select',
        { id, name: f.name, required: f.required },
        f.required ? null : h('option', { value: '' }, '—'),
        f.options.map((o) => h('option', { value: o }, o))
      );
    } else if (f.type === 'checklist') {
      return h(
        'fieldset',
        { class: 'field', 'data-name': f.name },
        h('legend', {}, h('strong', {}, label)),
        h(
          'div',
          { class: 'checklist' },
          f.options.map((o) => h('label', {}, h('input', { type: 'checkbox', name: f.name, value: o }), o))
        )
      );
    } else if (f.type === 'textarea') {
      input = h('textarea', { id, name: f.name, required: f.required, maxlength: f.maxLength, rows: 3 });
    } else if (f.type === 'number') {
      input = h('input', { id, name: f.name, type: 'number', inputmode: 'numeric', min: f.min, max: f.max, required: f.required });
    } else {
      input = h('input', { id, name: f.name, type: f.type, required: f.required, maxlength: f.maxLength });
    }
    // Without a menu, the free-text order is the only way to order, so it isn't optional.
    const optional = !f.required && !(f.labelWithoutMenu && !state.menu.length);
    return h(
      'div',
      { class: 'field', 'data-field': f.name },
      h('label', { for: id }, label, optional ? h('span', { class: 'muted small' }, ' (optional)') : ''),
      input
    );
  }

  // Shows fields whose `showIf` condition is met; hidden ones are disabled so
  // the browser skips their validation and they aren't submitted.
  function updateConditionalFields() {
    const form = $('request-form');
    for (const f of state.current.fields) {
      if (!f.showIf) continue;
      const visible = form.elements[f.showIf.field]?.value === f.showIf.equals;
      form.querySelector(`[data-field="${f.name}"]`).classList.toggle('hidden', !visible);
      form.elements[f.name].disabled = !visible;
    }
  }

  function openDialog(service) {
    state.current = service;
    state.cart = new Map();
    $('dialog-title').textContent = `${service.icon} ${service.name}`;
    $('dialog-desc').textContent = service.description;
    $('dialog-submit').textContent = 'Send request';
    $('dialog-fields').replaceChildren(...service.fields.map(renderField).filter(Boolean));
    updateConditionalFields();
    updateCartBar();
    $('note').value = '';
    $('dialog-error').classList.add('hidden');
    $('request-dialog').showModal();
  }

  function collectDetails(service) {
    const form = $('request-form');
    const details = {};
    for (const f of service.fields) {
      if (f.type === 'cart') {
        const lines = [...state.cart].map(([id, qty]) => ({ id, qty }));
        if (lines.length) details[f.name] = lines;
      } else if (f.type === 'checklist') {
        details[f.name] = [...form.querySelectorAll(`input[name="${f.name}"]:checked`)].map((i) => i.value);
      } else {
        const el = form.elements[f.name];
        if (el.disabled) continue;
        const v = el.value.trim();
        if (v !== '') details[f.name] = f.type === 'number' ? Number(v) : v;
      }
    }
    return details;
  }

  function dialogError(message) {
    $('dialog-error').textContent = message;
    $('dialog-error').classList.remove('hidden');
  }

  async function submitRequest(e) {
    e.preventDefault();
    const service = state.current;
    const details = collectDetails(service);
    for (const f of service.fields) {
      if (f.type === 'checklist' && f.required && !details[f.name].length) return dialogError('Please choose at least one item.');
    }
    if (service.requireOneOf && !service.requireOneOf.some((name) => details[name] !== undefined)) {
      return dialogError(state.menu.length ? 'Please add at least one item to your order.' : 'Please tell us what you would like.');
    }
    $('dialog-submit').disabled = true;
    try {
      const { request } = await api('POST', `${base}/requests`, {
        service: service.id,
        details,
        note: $('note').value,
      });
      upsert(request);
      $('request-dialog').close();
      toast(`${service.name} request sent — we're on it!`);
      $('requests-card').scrollIntoView({ behavior: 'smooth' });
    } catch (err) {
      if (err.status === 403) return relock();
      dialogError(err.message);
    } finally {
      $('dialog-submit').disabled = false;
    }
  }

  async function cancelRequest(r) {
    if (!confirm(`Cancel your ${r.serviceName} request?`)) return;
    try {
      const { request } = await api('POST', `${base}/requests/${r.id}/cancel`);
      upsert(request);
    } catch (err) {
      if (err.status === 403) return relock();
      toast(err.message);
    }
  }

  function upsert(request) {
    const i = state.requests.findIndex((r) => r.id === request.id);
    if (i >= 0) state.requests[i] = request;
    else state.requests.unshift(request);
    renderRequests();
  }

  // The stay ended or the QR code was replaced: reload, which shows the code
  // screen or an explanation.
  function relock() {
    if ($('request-dialog').open) $('request-dialog').close();
    state.stream?.close();
    state.stream = null;
    start();
  }

  // ---------------------------------------------------------------- loading
  async function load() {
    try {
      const data = await api('GET', base);
      state.hotel = data.hotel;
      renderHeader(data.hotel, data.room);
      if (data.locked) {
        showPinScreen(data.hotel);
        return false;
      }
      state.services = data.services;
      state.menu = data.menu;
      state.requests = data.requests;
      $('dnd').checked = data.room.dnd;
      renderInfo(data.hotel);
      renderServices();
      renderRequests();
      show(MAIN_CARDS, true);
      return true;
    } catch (err) {
      showError(err.status === 404 ? err.message : 'Could not load the page. Please check your connection and try again.');
      return false;
    }
  }

  function listen() {
    const es = new EventSource(`${base}/stream`);
    state.stream = es;
    const onRequest = (e) => {
      const { request } = JSON.parse(e.data);
      const previous = state.requests.find((r) => r.id === request.id);
      upsert(request);
      if (previous && previous.status !== request.status) {
        toast(`${request.serviceName}: ${STATUS_LABELS[request.status]}`);
      }
    };
    es.addEventListener('request:new', onRequest);
    es.addEventListener('request:update', onRequest);
    es.addEventListener('room:update', (e) => {
      const { room, reset } = JSON.parse(e.data);
      $('dnd').checked = room.dnd;
      if (reset) relock();
    });
    // The browser gives up on the stream when access has ended.
    es.addEventListener('error', () => {
      if (es.readyState === EventSource.CLOSED && state.stream === es) relock();
    });
    // Refresh when the stream reconnects so nothing is missed while offline.
    let opened = false;
    es.addEventListener('open', () => {
      if (opened) load();
      opened = true;
    });
  }

  async function start() {
    if (await load()) listen();
  }

  $('request-form').addEventListener('submit', submitRequest);
  $('request-form').addEventListener('change', updateConditionalFields);
  $('dialog-cancel').addEventListener('click', () => $('request-dialog').close());
  $('dnd').addEventListener('change', async (e) => {
    try {
      await api('POST', `${base}/dnd`, { dnd: e.target.checked });
      toast(e.target.checked ? 'Do Not Disturb is on' : 'Do Not Disturb is off');
    } catch (err) {
      e.target.checked = !e.target.checked;
      if (err.status === 403) return relock();
      toast(err.message);
    }
  });
  setInterval(renderRequests, 60000); // keep "x min ago" fresh

  start();
})();
