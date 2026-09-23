// Shared helpers for all pages.

async function api(method, url, body) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* non-JSON response */
  }
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Build DOM nodes without innerHTML so guest-supplied text can never inject markup.
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

const STATUS_LABELS = {
  new: 'Sent',
  acknowledged: 'Seen by staff',
  in_progress: 'On the way',
  completed: 'Done',
  cancelled: 'Cancelled',
};

const STAFF_STATUS_LABELS = {
  new: 'New',
  acknowledged: 'Acknowledged',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

function statusPill(status, labels = STATUS_LABELS) {
  return h('span', { class: `pill st-${status}` }, labels[status] || status);
}

function timeAgo(iso) {
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  return new Date(iso).toLocaleString();
}

let toastTimer;
function toast(message) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(el);
  }
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3500);
}

// Prices are in minor units (paise, cents).
function formatMoney(minor, currency = 'INR') {
  try {
    return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : undefined, {
      style: 'currency',
      currency,
      minimumFractionDigits: minor % 100 === 0 ? 0 : 2,
    }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
}

// "Today 06:00", "Tomorrow 06:00" or "Wed 24 Sep, 06:00" in the hotel's time zone.
function formatDue(iso, timeZone) {
  const date = new Date(iso);
  const dayKey = (d) => new Intl.DateTimeFormat('en-CA', { timeZone }).format(d);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit' }).format(date);
  const now = new Date();
  if (dayKey(date) === dayKey(now)) return `Today ${time}`;
  if (dayKey(date) === dayKey(new Date(now.getTime() + 864e5))) return `Tomorrow ${time}`;
  const day = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short' }).format(date);
  return `${day}, ${time}`;
}

// "in 3 h 5 min" / "12 min ago"
function relativeTime(iso) {
  const diff = new Date(iso).getTime() - Date.now();
  const mins = Math.round(Math.abs(diff) / 60000);
  const text = mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h${mins % 60 ? ` ${mins % 60} min` : ''}`;
  if (mins === 0) return 'now';
  return diff > 0 ? `in ${text}` : `${text} ago`;
}
