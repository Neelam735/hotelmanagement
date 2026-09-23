// Turns a guest's "06:00 tomorrow" into an exact instant in the hotel's time
// zone, without depending on the server's own time zone.

const PAST_TOLERANCE_MS = 60 * 1000;

function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return typeof tz === 'string' && tz.length > 0;
  } catch {
    return false;
  }
}

function zonedParts(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

// Offset of `tz` from UTC at `date`, in ms (e.g. +5:30 for Asia/Kolkata).
function tzOffsetMs(date, tz) {
  const p = zonedParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

// The UTC instant at which the wall clock in `tz` shows the given local time.
function zonedTimeToUtc(year, month, day, hour, minute, tz) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const offset = tzOffsetMs(new Date(guess), tz);
  let t = guess - offset;
  const offset2 = tzOffsetMs(new Date(t), tz);
  if (offset2 !== offset) t = guess - offset2; // crossed a DST change
  return new Date(t);
}

// schedule: { time: <field name>, day?: <field name with 'Today'|'Tomorrow'> }
// Returns { dueAt: Date|null } or { error }.
function computeDueAt(schedule, details, tz, now = new Date()) {
  if (!schedule) return { dueAt: null };
  const time = details[schedule.time];
  if (!time) return { dueAt: null };

  const [hour, minute] = time.split(':').map(Number);
  const today = zonedParts(now, tz);
  const at = (addDays) => {
    const d = new Date(Date.UTC(today.year, today.month - 1, today.day + addDays));
    return zonedTimeToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), hour, minute, tz);
  };

  const day = schedule.day ? details[schedule.day] : undefined;
  if (day === 'Tomorrow') return { dueAt: at(1) };

  const todayAt = at(0);
  const passed = todayAt.getTime() < now.getTime() - PAST_TOLERANCE_MS;
  if (day === 'Today') {
    if (passed) return { error: `${time} has already passed today. Please choose a later time or tomorrow.` };
    return { dueAt: todayAt };
  }
  // No day given: the next time the clock shows this time.
  return { dueAt: passed ? at(1) : todayAt };
}

module.exports = { computeDueAt, isValidTimeZone, zonedParts, zonedTimeToUtc };
