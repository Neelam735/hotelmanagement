(() => {
  const $ = (id) => document.getElementById(id);
  const state = {
    me: null,
    meta: null,
    scope: 'open',
    department: '',
    search: '',
    requests: new Map(),
    rooms: [],
    soundOn: true,
    replyTarget: null,
  };

  // ---------------------------------------------------------------- sound
  let audioCtx = null;
  function beep() {
    if (!state.soundOn) return;
    try {
      audioCtx = audioCtx || new AudioContext();
      const now = audioCtx.currentTime;
      [880, 1175].forEach((freq, i) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, now + i * 0.18);
        gain.gain.exponentialRampToValueAtTime(0.25, now + i * 0.18 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.18 + 0.16);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(now + i * 0.18);
        osc.stop(now + i * 0.18 + 0.17);
      });
    } catch {
      /* audio unavailable */
    }
  }

  // ---------------------------------------------------------------- rendering
  function matchesFilters(r) {
    if (state.department && r.department !== state.department) return false;
    if (state.search && !String(r.roomNumber).toLowerCase().includes(state.search)) return false;
    if (state.scope === 'open' && !['new', 'acknowledged', 'in_progress'].includes(r.status)) return false;
    return true;
  }

  function renderStats() {
    const all = [...state.requests.values()].filter(
      (r) => (!state.department || r.department === state.department) && ['new', 'acknowledged', 'in_progress'].includes(r.status)
    );
    const count = (s) => all.filter((r) => r.status === s).length;
    const oldestNew = all
      .filter((r) => r.status === 'new')
      .reduce((min, r) => Math.min(min, new Date(r.createdAt).getTime()), Infinity);
    const stats = [
      ['New', count('new')],
      ['Acknowledged', count('acknowledged')],
      ['In progress', count('in_progress')],
      ['Oldest waiting', Number.isFinite(oldestNew) ? timeAgo(new Date(oldestNew).toISOString()) : '—'],
    ];
    $('stats').replaceChildren(
      ...stats.map(([label, num]) => h('div', { class: 'stat' }, h('div', { class: 'num' }, num), h('div', { class: 'small muted' }, label)))
    );
    const newCount = count('new');
    document.title = newCount ? `(${newCount}) Guest Requests` : 'Guest Requests · Staff';
  }

  function actionButtons(r) {
    const btn = (label, status, cls = '') =>
      h('button', { type: 'button', class: `btn-sm ${cls}`, onclick: () => setStatus(r, status) }, label);
    const buttons = [];
    if (r.status === 'new') buttons.push(btn('✓ Acknowledge', 'acknowledged', 'btn-primary'));
    if (['new', 'acknowledged'].includes(r.status)) buttons.push(btn('▶ Start', 'in_progress'));
    if (['new', 'acknowledged', 'in_progress'].includes(r.status)) buttons.push(btn('✔ Complete', 'completed'));
    buttons.push(h('button', { type: 'button', class: 'btn-sm', onclick: () => openReply(r) }, '💬 Reply'));
    if (['completed', 'cancelled'].includes(r.status)) buttons.push(btn('↺ Reopen', 'acknowledged'));
    if (['new', 'acknowledged', 'in_progress'].includes(r.status)) buttons.push(btn('Cancel', 'cancelled', 'btn-danger'));
    return buttons;
  }

  function ticket(r) {
    const dept = state.meta.departments[r.department] || r.department;
    return h(
      'article',
      { class: `ticket s-${r.status}`, 'data-id': r.id },
      h(
        'div',
        { class: 'head' },
        h('span', { class: 'room-no' }, `Room ${r.roomNumber}`),
        h('span', {}, `${r.icon} ${r.serviceName}`),
        statusPill(r.status, STAFF_STATUS_LABELS),
        r.roomDnd ? h('span', { class: 'pill dnd' }, '🚫 Do Not Disturb') : null,
        h('span', { class: 'spacer' }),
        h('span', { class: 'small muted', title: new Date(r.createdAt).toLocaleString() }, timeAgo(r.createdAt))
      ),
      r.summary ? h('div', {}, r.summary) : null,
      r.note ? h('div', { class: 'small' }, h('strong', {}, 'Guest note: '), r.note) : null,
      r.staffReply ? h('div', { class: 'reply small' }, h('strong', {}, 'Your reply: '), r.staffReply) : null,
      h('div', { class: 'small muted' }, dept, r.handledBy ? ` · last updated by ${r.handledBy}` : ''),
      h('div', { class: 'actions' }, actionButtons(r))
    );
  }

  function renderBoard() {
    renderStats();
    const showRooms = state.scope === 'rooms';
    $('board').classList.toggle('hidden', showRooms);
    $('rooms-view').classList.toggle('hidden', !showRooms);
    if (showRooms) return renderRooms();

    const order = { new: 0, acknowledged: 1, in_progress: 2, completed: 3, cancelled: 4 };
    const list = [...state.requests.values()]
      .filter(matchesFilters)
      .sort((a, b) =>
        state.scope === 'open'
          ? order[a.status] - order[b.status] || a.createdAt.localeCompare(b.createdAt)
          : b.createdAt.localeCompare(a.createdAt)
      );
    $('board').replaceChildren(
      ...(list.length
        ? list.map(ticket)
        : [h('div', { class: 'card muted' }, state.scope === 'open' ? '🎉 No open requests right now.' : 'No requests found.')])
    );
  }

  function renderRooms() {
    const rooms = state.rooms.filter((r) => !state.search || r.number.toLowerCase().includes(state.search));
    $('rooms-body').replaceChildren(
      ...rooms.map((room) =>
        h(
          'tr',
          {},
          h('td', {}, h('strong', {}, room.number)),
          h('td', {}, room.floor || '—'),
          h('td', {}, room.openRequests || 0),
          h('td', {}, room.dnd ? h('span', { class: 'pill dnd' }, 'Do Not Disturb') : '—'),
          h('td', { class: 'small muted' }, new Date(room.stayStartedAt).toLocaleString()),
          h(
            'td',
            {},
            h(
              'button',
              { type: 'button', class: 'btn-sm', onclick: () => checkout(room), title: 'Use at check-out / check-in' },
              'New guest (reset)'
            )
          )
        )
      )
    );
    if (!rooms.length) {
      $('rooms-body').replaceChildren(h('tr', {}, h('td', { colspan: 6, class: 'muted' }, 'No rooms yet. An admin can add rooms on the Rooms & QR codes page.')));
    }
  }

  // ---------------------------------------------------------------- actions
  async function setStatus(r, status) {
    try {
      const { request } = await api('PATCH', `/api/staff/requests/${r.id}`, { status });
      state.requests.set(request.id, request);
      renderBoard();
    } catch (err) {
      handleError(err);
    }
  }

  function openReply(r) {
    state.replyTarget = r;
    $('reply-context').textContent = `Room ${r.roomNumber} · ${r.serviceName}`;
    $('reply-text').value = r.staffReply || '';
    $('reply-dialog').showModal();
  }

  async function sendReply(e) {
    e.preventDefault();
    const r = state.replyTarget;
    try {
      const body = { staffReply: $('reply-text').value };
      if (r.status === 'new') body.status = 'acknowledged';
      const { request } = await api('PATCH', `/api/staff/requests/${r.id}`, body);
      state.requests.set(request.id, request);
      $('reply-dialog').close();
      renderBoard();
      toast('Reply sent to guest');
    } catch (err) {
      handleError(err);
    }
  }

  async function checkout(room) {
    if (!confirm(`Reset room ${room.number} for a new guest?\n\nThis clears Do Not Disturb, cancels open requests and hides the previous guest's history from the room page.`)) return;
    try {
      await api('POST', `/api/staff/rooms/${room.id}/checkout`);
      await Promise.all([loadRequests(), loadRooms()]);
      toast(`Room ${room.number} is ready for the next guest`);
    } catch (err) {
      handleError(err);
    }
  }

  function handleError(err) {
    if (err.status === 401) location.href = '/login?next=/staff';
    else toast(err.message);
  }

  // ---------------------------------------------------------------- data
  async function loadRequests() {
    const scope = state.scope === 'all' ? 'all' : 'open';
    const { requests } = await api('GET', `/api/staff/requests?scope=${scope}`);
    state.requests = new Map(requests.map((r) => [r.id, r]));
    renderBoard();
  }

  async function loadRooms() {
    const { rooms } = await api('GET', '/api/staff/rooms');
    state.rooms = rooms;
    if (state.scope === 'rooms') renderRooms();
  }

  function listen() {
    const es = new EventSource('/api/staff/stream');
    let opened = false;
    es.addEventListener('open', () => {
      $('live').textContent = '● Live';
      if (opened) loadRequests().catch(handleError); // resync after reconnect
      opened = true;
    });
    es.addEventListener('error', () => {
      $('live').textContent = 'Reconnecting…';
    });
    es.addEventListener('request:new', (e) => {
      const { request } = JSON.parse(e.data);
      state.requests.set(request.id, request);
      renderBoard();
      if (!state.department || request.department === state.department) {
        beep();
        document.querySelector(`.ticket[data-id="${request.id}"]`)?.classList.add('flash');
        toast(`New: Room ${request.roomNumber} – ${request.serviceName}`);
      }
    });
    es.addEventListener('request:update', (e) => {
      const { request } = JSON.parse(e.data);
      state.requests.set(request.id, request);
      renderBoard();
    });
    es.addEventListener('room:update', (e) => {
      const { room } = JSON.parse(e.data);
      for (const r of state.requests.values()) if (r.roomId === room.id) r.roomDnd = room.dnd;
      loadRooms().catch(handleError);
      renderBoard();
    });
  }

  // ---------------------------------------------------------------- init
  async function init() {
    try {
      const [{ staff }, meta] = await Promise.all([api('GET', '/api/auth/me'), api('GET', '/api/meta')]);
      state.me = staff;
      state.meta = meta;
    } catch (err) {
      return handleError(err);
    }
    $('me').textContent = state.me.name;
    if (state.me.role === 'admin') $('admin-link').classList.remove('hidden');

    for (const [id, name] of Object.entries(state.meta.departments)) {
      $('department').append(h('option', { value: id }, name));
    }
    state.department = state.me.department || '';
    $('department').value = state.department;

    try {
      state.soundOn = localStorage.getItem('hm_sound') !== 'off';
    } catch {
      /* storage unavailable */
    }
    $('sound-btn').textContent = state.soundOn ? '🔔 Sound on' : '🔕 Sound off';

    await Promise.all([loadRequests(), loadRooms()]).catch(handleError);
    listen();
    setInterval(renderBoard, 60000);
  }

  document.querySelectorAll('[data-scope]').forEach((tab) =>
    tab.addEventListener('click', () => {
      document.querySelectorAll('[data-scope]').forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
      const previous = state.scope;
      state.scope = tab.dataset.scope;
      if (state.scope === 'rooms') loadRooms().then(renderBoard).catch(handleError);
      else if (previous !== state.scope) loadRequests().catch(handleError);
    })
  );
  $('department').addEventListener('change', (e) => {
    state.department = e.target.value;
    renderBoard();
  });
  $('search').addEventListener('input', (e) => {
    state.search = e.target.value.trim().toLowerCase();
    renderBoard();
  });
  $('sound-btn').addEventListener('click', () => {
    state.soundOn = !state.soundOn;
    try {
      localStorage.setItem('hm_sound', state.soundOn ? 'on' : 'off');
    } catch {
      /* storage unavailable */
    }
    $('sound-btn').textContent = state.soundOn ? '🔔 Sound on' : '🔕 Sound off';
    if (state.soundOn) beep();
  });
  $('logout').addEventListener('click', async () => {
    await api('POST', '/api/auth/logout').catch(() => {});
    location.href = '/login';
  });
  $('reply-form').addEventListener('submit', sendReply);
  $('reply-cancel').addEventListener('click', () => $('reply-dialog').close());

  init();
})();
