'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { formatDuration, msUntilNextTimeOfDay, wallClockToMs } = require('../lib/time');

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

describe('formatDuration', () => {
  test('seconds, never below 1 s', () => {
    assert.equal(formatDuration(11 * SECOND), '11 s');
    assert.equal(formatDuration(300), '1 s');
    assert.equal(formatDuration(0), '1 s');
  });

  test('minutes', () => {
    assert.equal(formatDuration(60 * SECOND), '1 min');
    assert.equal(formatDuration(90 * SECOND), '2 min');
    assert.equal(formatDuration(59.6 * SECOND), '1 min');
    assert.equal(formatDuration(45 * MINUTE), '45 min');
  });

  test('hours, with the leftover minutes', () => {
    assert.equal(formatDuration(2 * HOUR), '2 h');
    assert.equal(formatDuration(2 * HOUR + 5 * MINUTE), '2 h 5 min');
  });

  test('days, with the leftover hours', () => {
    assert.equal(formatDuration(24 * HOUR), '1 d');
    assert.equal(formatDuration(51 * HOUR), '2 d 3 h');
  });
});

describe('wallClockToMs', () => {
  test('resolves a wall-clock time against the given zone (winter: Zurich is UTC+1)', () => {
    assert.equal(wallClockToMs('2026-11-01T12:00', 'Europe/Zurich'), Date.UTC(2026, 10, 1, 11, 0));
  });

  test('and in summer (Zurich is UTC+2)', () => {
    assert.equal(wallClockToMs('2026-07-01T12:00', 'Europe/Zurich'), Date.UTC(2026, 6, 1, 10, 0));
  });

  test('west of UTC (New York after daylight saving ended: UTC-5)', () => {
    assert.equal(wallClockToMs('2026-11-01T12:00', 'America/New_York'), Date.UTC(2026, 10, 1, 17, 0));
  });

  test('UTC itself is the identity', () => {
    assert.equal(wallClockToMs('2026-11-01T12:34', 'UTC'), Date.UTC(2026, 10, 1, 12, 34));
  });

  test('is the inverse of what the zone shows for an instant', () => {
    const instant = Date.UTC(2026, 2, 15, 8, 45);
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(instant));
    const get = (type) => parts.find((p) => p.type === type).value;
    const wall = `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
    assert.equal(wallClockToMs(wall, 'Europe/Zurich'), instant);
  });

  test('NaN for anything that is not YYYY-MM-DDTHH:mm', () => {
    for (const bad of ['', 'nonsense', '2026-11-01', '2026-11-01 12:00', '2026-13-45T12:00']) {
      assert.ok(Number.isNaN(wallClockToMs(bad, 'Europe/Zurich')), bad);
    }
  });
});

describe('msUntilNextTimeOfDay', () => {
  // 21:30:00 UTC is 22:30 in Zurich in November (UTC+1) and 16:30 in New York (UTC-5).
  const now = new Date('2026-11-02T21:30:00.000Z');

  test('a time later today in the given time zone', () => {
    assert.equal(msUntilNextTimeOfDay('23:00', now, 'Europe/Zurich'), 30 * MINUTE);
  });

  test('a time that has already passed today means tomorrow', () => {
    assert.equal(msUntilNextTimeOfDay('06:00', now, 'Europe/Zurich'), 7.5 * HOUR);
  });

  test('the very same minute counts as tomorrow, not as "now"', () => {
    assert.equal(msUntilNextTimeOfDay('22:30', now, 'Europe/Zurich'), 24 * HOUR);
  });

  test('the same instant gives a different answer in another time zone', () => {
    assert.equal(msUntilNextTimeOfDay('23:00', now, 'America/New_York'), 6.5 * HOUR);
  });

  test('accepts a single-digit hour', () => {
    assert.equal(msUntilNextTimeOfDay('6:00', now, 'Europe/Zurich'), 7.5 * HOUR);
  });

  test('takes the seconds already elapsed in the current minute into account', () => {
    const midMinute = new Date('2026-11-02T21:30:30.250Z');
    assert.equal(msUntilNextTimeOfDay('23:00', midMinute, 'Europe/Zurich'), 30 * MINUTE - 30.25 * SECOND);
  });

  test('returns null for anything that is not a valid HH:mm time', () => {
    for (const bad of ['', null, undefined, 'abc', '24:00', '12:60', '1230', '12:5']) {
      assert.equal(msUntilNextTimeOfDay(bad, now, 'Europe/Zurich'), null, `"${bad}"`);
    }
  });

  test('works without an explicit time zone (the process zone)', () => {
    const ms = msUntilNextTimeOfDay('12:00', now);
    assert.ok(ms > 0 && ms <= 24 * HOUR);
  });
});
