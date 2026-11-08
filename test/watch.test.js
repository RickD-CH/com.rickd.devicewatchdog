'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const watch = require('../lib/watch');
const { formatWallClock } = require('../lib/time');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

describe('watchDurationMs', () => {
  test('minutes and hours', () => {
    assert.equal(watch.watchDurationMs(15, 'minutes'), 15 * MINUTE);
    assert.equal(watch.watchDurationMs('2', 'hours'), 2 * HOUR);
    assert.equal(watch.watchDurationMs(0.5, 'hours'), 30 * MINUTE);
  });

  test('rejects zero, negative, non-numbers and unknown units', () => {
    for (const [amount, unit] of [[0, 'minutes'], [-5, 'minutes'], ['abc', 'hours'], [null, 'hours'], [undefined, 'minutes'], [15, 'days'], [15, undefined]]) {
      assert.equal(watch.watchDurationMs(amount, unit), null, `${amount} ${unit}`);
    }
  });

  test('rejects more than a year', () => {
    assert.equal(watch.watchDurationMs(364 * 24, 'hours') !== null, true);
    assert.equal(watch.watchDurationMs(366 * 24, 'hours'), null);
  });
});

describe('desiredWatches', () => {
  const flow = (device, capability, amount, unit) => ({
    device: { id: device }, capability: { id: capability }, amount, unit,
  });

  test('one watch per distinct device + value + duration, however many Flows use it', () => {
    const watches = watch.desiredWatches([
      flow('a', 'measure_power', 15, 'minutes'),
      flow('a', 'measure_power', 15, 'minutes'),
      flow('a', 'measure_power', 1, 'hours'),
      flow('a', 'measure_temperature', 15, 'minutes'),
      flow('b', 'measure_power', 15, 'minutes'),
    ]);
    assert.equal(watches.size, 4);
    assert.deepEqual(watches.get(watch.watchKey('a', 'measure_power', 15 * MINUTE)), {
      deviceId: 'a', capabilityId: 'measure_power', durationMs: 15 * MINUTE,
    });
  });

  test('skips Flows that are not filled in completely or have an invalid duration', () => {
    const watches = watch.desiredWatches([
      { device: { id: 'a' }, amount: 15, unit: 'minutes' },
      { capability: { id: 'x' }, amount: 15, unit: 'minutes' },
      flow('a', 'x', 0, 'minutes'),
      flow('a', 'x', 15, 'weeks'),
      null,
      undefined,
    ]);
    assert.equal(watches.size, 0);
  });

  test('nothing in, nothing out', () => {
    assert.equal(watch.desiredWatches([]).size, 0);
    assert.equal(watch.desiredWatches(undefined).size, 0);
  });
});

describe('watchMatches', () => {
  const state = { deviceId: 'a', capabilityId: 'measure_power', durationMs: 15 * MINUTE };
  const args = (over = {}) => ({
    device: { id: 'a' }, capability: { id: 'measure_power' }, amount: 15, unit: 'minutes', ...over,
  });

  test('the Flow that watches exactly this freeze matches', () => {
    assert.equal(watch.watchMatches(args(), state), true);
    assert.equal(watch.watchMatches(args({ amount: 0.25, unit: 'hours' }), state), true, '15 minutes written as 0.25 h');
  });

  test('another device, value or duration does not', () => {
    assert.equal(watch.watchMatches(args({ device: { id: 'b' } }), state), false);
    assert.equal(watch.watchMatches(args({ capability: { id: 'measure_temperature' } }), state), false);
    assert.equal(watch.watchMatches(args({ amount: 30 }), state), false);
  });

  test('incomplete arguments never match', () => {
    assert.equal(watch.watchMatches({}, state), false);
    assert.equal(watch.watchMatches(args(), undefined), false);
  });
});

describe('capabilityLastUpdatedMs', () => {
  const device = {
    capabilitiesObj: { measure_power: { value: 5, lastUpdated: '2026-11-08T12:00:00.000Z' }, onoff: { value: true } },
  };

  test('reads the last-changed time of a value', () => {
    assert.equal(watch.capabilityLastUpdatedMs(device, 'measure_power'), Date.UTC(2026, 10, 8, 12, 0));
  });

  test('null when the value has no time, does not exist, or the device is missing', () => {
    assert.equal(watch.capabilityLastUpdatedMs(device, 'onoff'), null);
    assert.equal(watch.capabilityLastUpdatedMs(device, 'nope'), null);
    assert.equal(watch.capabilityLastUpdatedMs(null, 'measure_power'), null);
    assert.equal(watch.capabilityLastUpdatedMs({ capabilitiesObj: { x: { lastUpdated: 'garbage' } } }, 'x'), null);
  });
});

describe('capability titles, values and the autocomplete list', () => {
  test('title as a string, as a per-language object, or falling back to the id', () => {
    assert.equal(watch.capabilityTitle({ title: 'Temperature' }, 'measure_temperature'), 'Temperature');
    assert.equal(watch.capabilityTitle({ title: { en: 'Temperature', de: 'Temperatur' } }, 'x', 'de'), 'Temperatur');
    assert.equal(watch.capabilityTitle({ title: { en: 'Temperature' } }, 'x', 'sv'), 'Temperature');
    assert.equal(watch.capabilityTitle({}, 'measure_power'), 'measure_power');
  });

  test('value with its unit, empty when there is none', () => {
    assert.equal(watch.formatCapabilityValue({ value: 21.5, units: '°C' }), '21.5 °C');
    assert.equal(watch.formatCapabilityValue({ value: 0 }), '0');
    assert.equal(watch.formatCapabilityValue({ value: null }), '');
    assert.equal(watch.formatCapabilityValue(undefined), '');
  });

  const device = {
    capabilitiesObj: {
      measure_temperature: { title: 'Temperature', value: 21.5, units: '°C' },
      measure_battery: { title: 'Battery', value: 80, units: '%' },
      button: { title: 'Press' },
      'measure_power.l2': { title: { en: 'Power L2' }, value: 3, units: 'W' },
    },
  };

  test('lists the device\'s values sorted by name, without momentary button capabilities', () => {
    const names = watch.capabilityChoices(device, '').map((c) => c.name);
    assert.deepEqual(names, ['Battery', 'Power L2', 'Temperature']);
  });

  test('carries the id and the current value in the description', () => {
    const temperature = watch.capabilityChoices(device, '').find((c) => c.id === 'measure_temperature');
    assert.equal(temperature.description, 'measure_temperature - 21.5 °C');
  });

  test('filters by what was typed (title or id)', () => {
    assert.deepEqual(watch.capabilityChoices(device, 'temp').map((c) => c.id), ['measure_temperature']);
    assert.deepEqual(watch.capabilityChoices(device, 'power.l2').map((c) => c.id), ['measure_power.l2']);
    assert.deepEqual(watch.capabilityChoices(device, 'zzz'), []);
  });

  test('no device, no choices', () => {
    assert.deepEqual(watch.capabilityChoices(null, ''), []);
  });
});

describe('formatWallClock', () => {
  test('shows the wall clock of the given zone', () => {
    const instant = Date.UTC(2026, 10, 8, 13, 30);
    assert.equal(formatWallClock(instant, 'Europe/Zurich'), '2026-11-08 14:30');
    assert.equal(formatWallClock(instant, 'UTC'), '2026-11-08 13:30');
  });
});
