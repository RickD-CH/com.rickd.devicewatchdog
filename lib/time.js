'use strict';

/**
 * Pure time helpers (no Homey dependencies) so they can be unit tested, same idea as
 * lib/scanner.js and lib/rules.js.
 */

// How long a device was unavailable, for the Timeline's "available again" entry:
// "11 s" / "3 min" / "2 h 5 min" / "2 d 3 h".
function formatDuration(ms) {
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds} s`;
  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) return minutes ? `${hours} h ${minutes} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours ? `${days} d ${remHours} h` : `${days} d`;
}

// Milliseconds from `now` until the next HH:mm wall-clock time in `timeZone` (undefined =
// the process's own zone). The same minute again counts as tomorrow. Returns null for a
// value that isn't a valid HH:mm time.
function msUntilNextTimeOfDay(time, now = new Date(), timeZone = undefined) {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(time || '').trim());
  if (!match) return null;
  const targetSeconds = (Number(match[1]) * 60 + Number(match[2])) * 60;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const part = (type) => Number(parts.find((p) => p.type === type).value);
  const nowSeconds = part('hour') * 3600 + part('minute') * 60 + part('second');
  let diff = targetSeconds - nowSeconds;
  if (diff <= 0) diff += 86400;
  return diff * 1000 - now.getMilliseconds();
}

module.exports = { formatDuration, msUntilNextTimeOfDay };
