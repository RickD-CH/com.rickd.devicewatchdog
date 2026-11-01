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

// Offset of `timeZone` from UTC at the instant `ms`, in milliseconds (east of UTC is positive).
function timeZoneOffsetMs(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const part = (type) => Number(parts.find((p) => p.type === type).value);
  const wallAsUtc = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'));
  return wallAsUtc - Math.floor(ms / 1000) * 1000;
}

// The instant (epoch ms) at which the wall clock of `timeZone` reads "YYYY-MM-DDTHH:mm". The app
// process itself may run in another zone than the Homey (it runs in UTC on a Homey Pro), so a stored
// "until 14:30" has to be resolved against the Homey's zone, not the process's. NaN if unparsable.
function wallClockToMs(dateTime, timeZone) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(dateTime));
  if (!match) return NaN;
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  // Date.UTC quietly rolls "month 13" or "Feb 30" over into the next month - reject those.
  const check = new Date(wallAsUtc);
  if (Number.isNaN(wallAsUtc) || hour > 23 || minute > 59
    || check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return NaN;
  }
  // The offset depends on the instant being searched for (daylight saving) - refine twice.
  let guess = wallAsUtc - timeZoneOffsetMs(wallAsUtc, timeZone);
  guess = wallAsUtc - timeZoneOffsetMs(guess, timeZone);
  return guess;
}

module.exports = { formatDuration, msUntilNextTimeOfDay, wallClockToMs };
