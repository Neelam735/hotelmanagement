(() => {
  const token = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '');
  const base = `/api/guest/${encodeURIComponent(token)}`;

  const state = { services: [], requests: [], current: null };
  const $ = (id) => document.getElementById(id);

  function showError(message) {
    $('error-text').textContent = message;
    $('error').classList.remove('hidden');
    for (const id of ['services-card', 'requests-card', 'room-card', 'info-card']) $(id).classList.add('hidden');
  }

  function renderHeader(hotel, room) {
    document.title = `${hotel.name} · Room ${room.number}`;
    $('hotel-name').textContent = hotel.name;
    $('room-label').textContent = `Room ${room.number}`;
    $('welcome').textContent = hotel.welcomeMessage;
    $('dnd').checked = room.dnd;

    const info = [];
    if (hotel.wifiName) info.push(['Wi-Fi network', hotel.wifiName]);
    if (hotel.wifiPassword) info.push(['Wi-Fi password', hotel.wifiPassword]);
    if (hotel.receptionPhone) {
      info.push(['Reception (emergencies)', h('a', { href: `tel:${hotel.receptionPhone}` }, hotel.receptionPhone)]);
    }
    if (info.length) {
      $('info').replaceChildren(...info.map(([k, v]) => h('div', {}, h('span', { class: 'muted' }, k), h('strong', {}, v))));
      $('info-card').classList.remove('hidden');
    }
  }

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

  function renderField(f) {
    const id = `f-${f.name}`;
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
        h('legend', {}, h('strong', {}, f.label)),
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
    return h(
      'div',
      { class: 'field', 'data-field': f.name },
      h('label', { for: id }, f.label, f.required ? '' : h('span', { class: 'muted small' }, ' (optional)')),
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
    $('dialog-title').textContent = `${service.icon} ${service.name}`;
    $('dialog-desc').textContent = service.description;
    $('dialog-fields').replaceChildren(...service.fields.map(renderField));
    updateConditionalFields();
    $('note').value = '';
    $('dialog-error').classList.add('hidden');
    $('request-dialog').showModal();
  }

  function collectDetails(service) {
    const form = $('request-form');
    const details = {};
    for (const f of service.fields) {
      if (f.type === 'checklist') {
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

  async function submitRequest(e) {
    e.preventDefault();
    const service = state.current;
    const details = collectDetails(service);
    for (const f of service.fields) {
      if (f.type === 'checklist' && f.required && !details[f.name].length) {
        $('dialog-error').textContent = `Please choose at least one item.`;
        $('dialog-error').classList.remove('hidden');
        return;
      }
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
      $('dialog-error').textContent = err.message;
      $('dialog-error').classList.remove('hidden');
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
      toast(err.message);
    }
  }

  function upsert(request) {
    const i = state.requests.findIndex((r) => r.id === request.id);
    if (i >= 0) state.requests[i] = request;
    else state.requests.unshift(request);
    renderRequests();
  }

  async function load() {
    try {
      const data = await api('GET', base);
      state.services = data.services;
      state.requests = data.requests;
      renderHeader(data.hotel, data.room);
      renderServices();
      renderRequests();
      return true;
    } catch (err) {
      showError(err.status === 404 ? err.message : 'Could not load the page. Please check your connection and try again.');
      return false;
    }
  }

  function listen() {
    const es = new EventSource(`${base}/stream`);
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
      if (reset) load();
    });
    // A closed stream means the link stopped working (e.g. a new QR code was
    // issued); reloading shows the guest the explanation.
    es.addEventListener('error', () => {
      if (es.readyState === EventSource.CLOSED) load();
    });
    // Refresh when the stream reconnects so nothing is missed while offline.
    let opened = false;
    es.addEventListener('open', () => {
      if (opened) load();
      opened = true;
    });
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
      toast(err.message);
    }
  });
  setInterval(renderRequests, 60000); // keep "x min ago" fresh

  load().then((ok) => ok && listen());
})();
