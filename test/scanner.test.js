'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const scanner = require('../lib/scanner');

const HOUR = 3600 * 1000;

function device(overrides) {
  return {
    id: 'dev-1',
    name: 'Device 1',
    zone: null,
    class: 'sensor',
    available: true,
    capabilities: [],
    capabilitiesObj: {},
    ...overrides,
  };
}

describe('safeRegExp', () => {
  test('returns a working RegExp for a valid pattern', () => {
    const re = scanner.safeRegExp('^foo');
    assert.ok(re instanceof RegExp);
    assert.equal(re.test('foobar'), true);
  });

  test('returns null instead of throwing for an invalid pattern', () => {
    assert.equal(scanner.safeRegExp('('), null);
  });

  test('returns null for an empty/falsy pattern', () => {
    assert.equal(scanner.safeRegExp(''), null);
    assert.equal(scanner.safeRegExp(null), null);
  });
});

describe('formatDate', () => {
  test('returns null for null input', () => {
    assert.equal(scanner.formatDate(null), null);
  });

  test('returns null for an invalid Date', () => {
    assert.equal(scanner.formatDate(new Date('not a date')), null);
  });

  test('returns an ISO string for a valid Date', () => {
    const d = new Date('2026-01-01T00:00:00.000Z');
    assert.equal(scanner.formatDate(d), '2026-01-01T00:00:00.000Z');
  });
});

describe('buildZoneOrderMap', () => {
  test('walks the zone tree in pre-order, siblings sorted by order then name', () => {
    const zones = {
      basement: {
        id: 'basement', name: 'Basement', parent: null, order: 1,
      },
      attic: {
        id: 'attic', name: 'Attic', parent: null, order: 0,
      },
      'attic-left': {
        id: 'attic-left', name: 'Left', parent: 'attic', order: 0,
      },
      'attic-right': {
        id: 'attic-right', name: 'Right', parent: 'attic', order: 1,
      },
    };

    const map = scanner.buildZoneOrderMap(zones);

    // Attic (order 0) before Basement (order 1), children visited before the next root sibling.
    assert.equal(map.attic, 0);
    assert.equal(map['attic-left'], 1);
    assert.equal(map['attic-right'], 2);
    assert.equal(map.basement, 3);
  });

  test('falls back to name when order is missing/equal', () => {
    const zones = {
      b: { id: 'b', name: 'Bravo', parent: null },
      a: { id: 'a', name: 'Alpha', parent: null },
    };
    const map = scanner.buildZoneOrderMap(zones);
    assert.ok(map.a < map.b);
  });

  test('handles an empty zone map', () => {
    assert.deepEqual(scanner.buildZoneOrderMap({}), {});
    assert.deepEqual(scanner.buildZoneOrderMap(undefined), {});
  });
});

describe('findRule', () => {
  const rules = [
    { id: 'r-id', matchType: 'id', matchValue: 'dev-1' },
    { id: 'r-name', matchType: 'name', matchValue: 'Garage sensor' },
    { id: 'r-pattern', matchType: 'pattern', matchValue: '^Garage' },
  ];

  test('exact ID match wins over name and pattern', () => {
    const { rule, ruleApplied } = scanner.findRule(device({ id: 'dev-1', name: 'Garage sensor' }), rules);
    assert.equal(rule.id, 'r-id');
    assert.equal(ruleApplied, 'ID');
  });

  test('exact name match wins over pattern when ID does not match', () => {
    const { rule, ruleApplied } = scanner.findRule(device({ id: 'dev-2', name: 'Garage sensor' }), rules);
    assert.equal(rule.id, 'r-name');
    assert.equal(ruleApplied, 'NM');
  });

  test('falls back to a matching pattern', () => {
    const { rule, ruleApplied } = scanner.findRule(device({ id: 'dev-3', name: 'Garage door' }), rules);
    assert.equal(rule.id, 'r-pattern');
    assert.equal(ruleApplied, 'PT');
  });

  test('returns no rule when nothing matches', () => {
    const { rule, ruleApplied } = scanner.findRule(device({ id: 'dev-9', name: 'Kitchen light' }), rules);
    assert.equal(rule, null);
    assert.equal(ruleApplied, '--');
  });

  test('an invalid regex pattern rule is skipped, not thrown', () => {
    const badRules = [{ id: 'r-bad', matchType: 'pattern', matchValue: '(' }];
    const { rule, ruleApplied } = scanner.findRule(device({ name: 'Anything' }), badRules);
    assert.equal(rule, null);
    assert.equal(ruleApplied, '--');
  });
});

describe('computeDeviceStatus', () => {
  const config = { notReportingThresholdHours: 24, batteryThresholdPercent: 30 };

  test('reporting is true when the device updated recently', () => {
    const d = device({
      capabilitiesObj: { onoff: { value: true, lastUpdated: new Date(Date.now() - HOUR).toISOString() } },
    });
    const status = scanner.computeDeviceStatus(d, null, config);
    assert.equal(status.isReporting, true);
  });

  test('reporting is false once the device is older than the threshold', () => {
    const d = device({
      capabilitiesObj: { onoff: { value: true, lastUpdated: new Date(Date.now() - 25 * HOUR).toISOString() } },
    });
    const status = scanner.computeDeviceStatus(d, null, config);
    assert.equal(status.isReporting, false);
  });

  test('a per-device notReportingHours override replaces the global threshold', () => {
    const d = device({
      capabilitiesObj: { onoff: { value: true, lastUpdated: new Date(Date.now() - 2 * HOUR).toISOString() } },
    });
    const status = scanner.computeDeviceStatus(d, { notReportingHours: 1 }, config);
    assert.equal(status.isReporting, false);
  });

  test('onlyCheckBattery skips the reporting check entirely', () => {
    const d = device({ capabilitiesObj: {} }); // no lastUpdated at all
    const status = scanner.computeDeviceStatus(d, { onlyCheckBattery: true }, config);
    assert.equal(status.isReporting, true);
  });

  test('a device with no capability data at all is treated as not reporting', () => {
    const d = device({ capabilitiesObj: {} });
    const status = scanner.computeDeviceStatus(d, null, config);
    assert.equal(status.isReporting, false);
  });

  test('battery percentage at/below the threshold is flagged low', () => {
    const d = device({ capabilitiesObj: { measure_battery: { value: 30 } } });
    const status = scanner.computeDeviceStatus(d, null, config);
    assert.equal(status.isLowBattery, true);
    assert.equal(status.batteryStatus, '30%');
  });

  test('battery percentage above the threshold is not flagged', () => {
    const d = device({ capabilitiesObj: { measure_battery: { value: 31 } } });
    const status = scanner.computeDeviceStatus(d, null, config);
    assert.equal(status.isLowBattery, false);
  });

  test('a per-device batteryThreshold of 0 is honoured, not treated as "unset"', () => {
    const d = device({ capabilitiesObj: { measure_battery: { value: 5 } } });
    const status = scanner.computeDeviceStatus(d, { batteryThreshold: 0 }, config);
    assert.equal(status.isLowBattery, false);
  });

  test('a battery alarm is always flagged low, regardless of percentage', () => {
    const d = device({ capabilitiesObj: { alarm_battery: { value: true } } });
    const status = scanner.computeDeviceStatus(d, null, config);
    assert.equal(status.isLowBattery, true);
    assert.equal(status.batteryStatus, 'ALARM');
  });

  test('excludeBattery reports EXCL and never flags low battery', () => {
    const d = device({ capabilitiesObj: { measure_battery: { value: 1 } } });
    const status = scanner.computeDeviceStatus(d, { excludeBattery: true }, config);
    assert.equal(status.batteryStatus, 'EXCL');
    assert.equal(status.isLowBattery, false);
  });

  test('a device without a battery capability at all reports N/A', () => {
    const d = device({ capabilities: [], capabilitiesObj: {} });
    const status = scanner.computeDeviceStatus(d, null, config);
    assert.equal(status.batteryStatus, 'N/A');
  });

  test('a device with the capability but no value yet reports OK', () => {
    const d = device({ capabilities: ['measure_battery'], capabilitiesObj: {} });
    const status = scanner.computeDeviceStatus(d, null, config);
    assert.equal(status.batteryStatus, 'OK');
  });
});

describe('runScan', () => {
  const config = { notReportingThresholdHours: 24, batteryThresholdPercent: 30 };
  const zones = { zoneA: { id: 'zoneA', name: 'Living room' } };

  test('sorts devices into all/notReporting/lowBattery and resolves zone names', () => {
    const devices = {
      good: device({
        id: 'good',
        name: 'Good device',
        zone: 'zoneA',
        capabilitiesObj: { onoff: { value: true, lastUpdated: new Date().toISOString() }, measure_battery: { value: 80 } },
      }),
      stale: device({
        id: 'stale',
        name: 'Stale device',
        capabilitiesObj: { onoff: { value: true, lastUpdated: new Date(Date.now() - 48 * HOUR).toISOString() } },
      }),
      lowBatt: device({
        id: 'lowBatt',
        name: 'Low battery device',
        capabilitiesObj: { onoff: { value: true, lastUpdated: new Date().toISOString() }, measure_battery: { value: 10 } },
      }),
    };

    const result = scanner.runScan({
      devices, zones, rules: [], config,
    });

    assert.equal(result.all.length, 3);
    assert.deepEqual(result.notReporting.map((d) => d.id), ['stale']);
    assert.deepEqual(result.lowBattery.map((d) => d.id), ['lowBatt']);
    assert.equal(result.excluded.length, 0);

    const good = result.all.find((d) => d.id === 'good');
    assert.equal(good.zone, 'Living room');
    assert.equal(good.status, 'OK');
  });

  test('a rule with excludeAll removes the device from every list', () => {
    const devices = {
      excludedDev: device({
        id: 'excludedDev',
        name: 'Excluded device',
        capabilitiesObj: {},
      }),
    };
    const rules = [{
      id: 'r1', matchType: 'id', matchValue: 'excludedDev', excludeAll: true,
    }];

    const result = scanner.runScan({
      devices, zones, rules, config,
    });

    assert.equal(result.all.length, 0);
    assert.equal(result.notReporting.length, 0);
    assert.equal(result.excluded.length, 1);
    assert.equal(result.excluded[0].id, 'excludedDev');
  });
});
