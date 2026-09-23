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
    alerted: new Set(), // "id:state" pairs already announced
  };

  const OPEN = ['new', 'acknowledged', 'in_progress'];
  const ALERT_REPEAT_MS = 60 * 1000;
  let lastAlertAt = 0;

  // Where an open request stands in time:
  //   scheduled – has a due time that isn't close yet
  //   due       – due time is within the reminder window or has passed
  //   overdue   – scheduled: well past due and not done; unscheduled: nobody
  //               has picked it up within the hotel's overdue limit
  //   normal    – everything else
  function timing(r, now = Date.now()) {
    if (!OPEN.includes(r.status)) return 'closed';
    if (r.dueAt) {
      if (now >= Date.parse(r.overdueAt)) return 'overdue';
      if (now >= Date.parse(r.remindAt)) return 'due';
      return 'scheduled';
    }
    if (r.status === 'new' && now >= Date.parse(r.overdueAt)) return 'overdue';
    return 'normal';
  }

  // Needs someone to act now: due or overdue, and nobody has started on it.
  function needsAttention(r, now = Date.now()) {
    const t = timing(r, now);
    return (t === 'due' || t === 'overdue') && r.status !== 'in_progress';
  }

  function inMyDepartment(r) {
    return !state.department || r.department === state.department;
  }

  // ---------------------------------------------------------------- sound
  // Browsers keep audio blocked until the user interacts with the page, so the
  // sound button tells staff when they need to click to enable alerts.
  let audioCtx = null;
  function ensureAudio() {
    try {
      audioCtx = audioCtx || new AudioContext();
      if (audioCtx.state === 'suspended') audioCtx.resume().then(updateSoundButton, () => {});
    } catch {
      /* audio unavailable */
    }
    updateSoundButton();
  }

  function updateSoundButton() {
    const blocked = state.soundOn && (!audioCtx || audioCtx.state !== 'running');
    $('sound-btn').textContent = !state.soundOn ? '🔕 Sound off' : blocked ? '🔇 Click to enable sound' : '🔔 Sound on';
    $('sound-btn').classList.toggle('btn-warn', blocked);
  }

  function beep() {
    if (!state.soundOn) return;
    try {
      ensureAudio();
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
    const now = Date.now();
    const open = [...state.requests.values()].filter((r) => inMyDepartment(r) && OPEN.includes(r.status));
    const count = (s) => open.filter((r) => r.status === s && timing(r, now) !== 'scheduled').length;
    const attention = open.filter((r) => needsAttention(r, now)).length;
    const stats = [
      ['Needs attention now', attention, attention ? 'stat-alert' : ''],
      ['New', count('new')],
      ['Acknowledged', count('acknowledged')],
      ['In progress', count('in_progress')],
      ['Scheduled later', open.filter((r) => timing(r, now) === 'scheduled').length],
    ];
    $('stats').replaceChildren(
      ...stats.map(([label, num, cls]) =>
        h('div', { class: `stat ${cls || ''}` }, h('div', { class: 'num' }, num), h('div', { class: 'small muted' }, label))
      )
    );
    const badge = attention || count('new');
    document.title = badge ? `(${badge}) Guest Requests` : 'Guest Requests · Staff';
  }

  function renderAttention() {
    const now = Date.now();
    const urgent = [...state.requests.values()].filter((r) => inMyDepartment(r) && needsAttention(r, now));
    $('attention').classList.toggle('hidden', !urgent.length);
    $('attention').replaceChildren(
      h('strong', {}, `⏰ ${urgent.length} request${urgent.length === 1 ? '' : 's'} need${urgent.length === 1 ? 's' : ''} attention now`),
      h(
        'ul',
        {},
        urgent.map((r) => h('li', {}, `Room ${r.roomNumber} · ${r.serviceName} — ${timingText(r, now)}`))
      )
    );
  }

  function timingText(r, now = Date.now()) {
    const t = timing(r, now);
    const tz = state.meta.timezone;
    if (r.dueAt) {
      if (t === 'scheduled') return `Due ${formatDue(r.dueAt, tz)} (${relativeTime(r.dueAt)})`;
      if (t === 'due') return Date.parse(r.dueAt) > now ? `Due ${relativeTime(r.dueAt)} (${formatDue(r.dueAt, tz)})` : `DUE NOW (${formatDue(r.dueAt, tz)})`;
      if (t === 'overdue') return `Overdue — was due ${formatDue(r.dueAt, tz)}`;
      return `Was due ${formatDue(r.dueAt, tz)}`;
    }
    if (t === 'overdue') return `Waiting ${relativeTime(r.createdAt).replace(' ago', '')} — not picked up yet`;
    return '';
  }

  // Beeps for anything that newly needs attention, and repeats every minute
  // while anything is still waiting, so a wake-up call can't slip by.
  function checkAlerts() {
    const now = Date.now();
    const urgent = [...state.requests.values()].filter((r) => inMyDepartment(r) && needsAttention(r, now));
    const fresh = urgent.filter((r) => !state.alerted.has(`${r.id}:${timing(r, now)}`));
    for (const r of fresh) state.alerted.add(`${r.id}:${timing(r, now)}`);
    if (fresh.length) {
      const r = fresh[0];
      toast(`⏰ Room ${r.roomNumber} – ${r.serviceName}: ${timingText(r, now)}`);
    }
    if (fresh.length || (urgent.length && now - lastAlertAt >= ALERT_REPEAT_MS)) {
      lastAlertAt = now;
      beep();
    }
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
    const t = timing(r);
    const when = timingText(r);
    return h(
      'article',
      { class: `ticket s-${r.status} t-${t}`, 'data-id': r.id },
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
      when ? h('div', { class: `timing timing-${t}` }, t === 'scheduled' ? `⏰ ${when}` : `⚠️ ${when}`) : null,
      r.summary ? h('div', {}, r.summary) : null,
      r.note ? h('div', { class: 'small' }, h('strong', {}, 'Guest note: '), r.note) : null,
      r.staffReply ? h('div', { class: 'reply small' }, h('strong', {}, 'Your reply: '), r.staffReply) : null,
      h('div', { class: 'small muted' }, dept, r.handledBy ? ` · last updated by ${r.handledBy}` : ''),
      h('div', { class: 'actions' }, actionButtons(r))
    );
  }

  function renderBoard() {
    renderStats();
    renderAttention();
    const showRooms = state.scope === 'rooms';
    $('board').classList.toggle('hidden', showRooms);
    $('rooms-view').classList.toggle('hidden', !showRooms);
    if (showRooms) return renderRooms();

    // Open view: urgent first, then by status, with far-off scheduled
    // requests last; within a group, whatever needs doing soonest first.
    const now = Date.now();
    const rank = (r) => {
      if (needsAttention(r, now)) return 0;
      if (timing(r, now) === 'scheduled') return 4;
      return { new: 1, acknowledged: 2, in_progress: 3 }[r.status] ?? 5;
    };
    const when = (r) => Date.parse(r.remindAt || r.createdAt);
    const list = [...state.requests.values()]
      .filter(matchesFilters)
      .sort((a, b) =>
        state.scope === 'open' ? rank(a) - rank(b) || when(a) - when(b) : b.createdAt.localeCompare(a.createdAt)
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
          h(
            'td',
            {},
            h('span', { class: 'pin-cell' }, room.pin || '—'),
            ' ',
            h('button', { type: 'button', class: 'btn-sm', onclick: () => newPin(room), title: 'Issue a different code for the current guest' }, 'New code')
          ),
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
      $('rooms-body').replaceChildren(h('tr', {}, h('td', { colspan: 7, class: 'muted' }, 'No rooms yet. An admin can add rooms on the Rooms & QR codes page.')));
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

  function showPin(title, pin) {
    $('pin-dialog-title').textContent = title;
    $('pin-dialog-code').textContent = pin;
    $('pin-dialog').showModal();
  }

  async function checkout(room) {
    if (!confirm(`Reset room ${room.number} for a new guest?\n\nThis clears Do Not Disturb, cancels open requests, signs out the previous guest's phones and creates a new room code.`)) return;
    try {
      const { pin } = await api('POST', `/api/staff/rooms/${room.id}/checkout`);
      await Promise.all([loadRequests(), loadRooms()]);
      showPin(`Room ${room.number} is ready for the next guest`, pin);
    } catch (err) {
      handleError(err);
    }
  }

  async function newPin(room) {
    if (!confirm(`Create a different room code for room ${room.number}?\n\nPhones already signed in stay signed in; the old code stops working.`)) return;
    try {
      const { pin } = await api('POST', `/api/staff/rooms/${room.id}/new-pin`);
      await loadRooms();
      showPin(`New code for room ${room.number}`, pin);
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
      // The browser gives up after a non-stream response (e.g. session expired):
      // find out why and retry ourselves.
      if (es.readyState === EventSource.CLOSED) {
        api('GET', '/api/auth/me')
          .then(() =>
            setTimeout(() => {
              listen();
              loadRequests().catch(handleError);
            }, 3000)
          )
          .catch(handleError);
      }
    });
    es.addEventListener('request:new', (e) => {
      const { request } = JSON.parse(e.data);
      state.requests.set(request.id, request);
      if (state.scope === 'rooms') loadRooms().catch(handleError);
      renderBoard();
      if (inMyDepartment(request)) {
        beep();
        document.querySelector(`.ticket[data-id="${request.id}"]`)?.classList.add('flash');
        const due = request.dueAt ? ` (due ${formatDue(request.dueAt, state.meta.timezone)})` : '';
        toast(`New: Room ${request.roomNumber} – ${request.serviceName}${due}`);
      }
    });
    es.addEventListener('request:update', (e) => {
      const { request } = JSON.parse(e.data);
      state.requests.set(request.id, request);
      if (state.scope === 'rooms') loadRooms().catch(handleError);
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
    ensureAudio();
    document.addEventListener('pointerdown', ensureAudio);
    document.addEventListener('keydown', ensureAudio);

    await Promise.all([loadRequests(), loadRooms()]).catch(handleError);
    listen();
    // Re-evaluate due/overdue states regularly; nothing else would trigger it.
    setInterval(() => {
      renderBoard();
      checkAlerts();
    }, 15000);
    checkAlerts();
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
    checkAlerts();
  });
  $('search').addEventListener('input', (e) => {
    state.search = e.target.value.trim().toLowerCase();
    renderBoard();
  });
  $('sound-btn').addEventListener('click', (e) => {
    // "Click to enable sound": the click itself unlocks audio; don't turn it off.
    if (e.currentTarget.classList.contains('btn-warn')) {
      ensureAudio();
      beep();
      return;
    }
    state.soundOn = !state.soundOn;
    try {
      localStorage.setItem('hm_sound', state.soundOn ? 'on' : 'off');
    } catch {
      /* storage unavailable */
    }
    updateSoundButton();
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
