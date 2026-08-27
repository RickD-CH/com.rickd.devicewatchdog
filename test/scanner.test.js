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

describe('buildRuleIndex + findRuleIndexed', () => {
  // Same rules/fixtures as the findRule suite above, on purpose - findRuleIndexed is a
  // drop-in, faster replacement and must agree with findRule on every case, not just its
  // own cases.
  const rules = [
    { id: 'r-id', matchType: 'id', matchValue: 'dev-1' },
    { id: 'r-name', matchType: 'name', matchValue: 'Garage sensor' },
    { id: 'r-pattern', matchType: 'pattern', matchValue: '^Garage' },
  ];

  test('exact ID match wins over name and pattern', () => {
    const { rule, ruleApplied } = scanner.findRuleIndexed(device({ id: 'dev-1', name: 'Garage sensor' }), scanner.buildRuleIndex(rules));
    assert.equal(rule.id, 'r-id');
    assert.equal(ruleApplied, 'ID');
  });

  test('exact name match wins over pattern when ID does not match', () => {
    const { rule, ruleApplied } = scanner.findRuleIndexed(device({ id: 'dev-2', name: 'Garage sensor' }), scanner.buildRuleIndex(rules));
    assert.equal(rule.id, 'r-name');
    assert.equal(ruleApplied, 'NM');
  });

  test('falls back to a matching pattern', () => {
    const { rule, ruleApplied } = scanner.findRuleIndexed(device({ id: 'dev-3', name: 'Garage door' }), scanner.buildRuleIndex(rules));
    assert.equal(rule.id, 'r-pattern');
    assert.equal(ruleApplied, 'PT');
  });

  test('returns no rule when nothing matches', () => {
    const { rule, ruleApplied } = scanner.findRuleIndexed(device({ id: 'dev-9', name: 'Kitchen light' }), scanner.buildRuleIndex(rules));
    assert.equal(rule, null);
    assert.equal(ruleApplied, '--');
  });

  test('an invalid regex pattern rule is skipped, not thrown', () => {
    const badIndex = scanner.buildRuleIndex([{ id: 'r-bad', matchType: 'pattern', matchValue: '(' }]);
    const { rule, ruleApplied } = scanner.findRuleIndexed(device({ name: 'Anything' }), badIndex);
    assert.equal(rule, null);
    assert.equal(ruleApplied, '--');
  });

  test('first rule of a type wins, same as Array#find on the raw array', () => {
    const dupeRules = [
      { id: 'r-first', matchType: 'id', matchValue: 'dev-1' },
      { id: 'r-second', matchType: 'id', matchValue: 'dev-1' },
    ];
    const dupeIndex = scanner.buildRuleIndex(dupeRules);
    const viaIndex = scanner.findRuleIndexed(device({ id: 'dev-1' }), dupeIndex);
    const viaArray = scanner.findRule(device({ id: 'dev-1' }), dupeRules);
    assert.equal(viaIndex.rule.id, 'r-first');
    assert.equal(viaIndex.rule.id, viaArray.rule.id);
  });
});

describe('canCheckStaleness', () => {
  test('true for a device with any non-button capability', () => {
    assert.equal(scanner.canCheckStaleness(device({ capabilities: ['onoff'] })), true);
    assert.equal(scanner.canCheckStaleness(device({ capabilities: ['button', 'measure_battery'] })), true);
  });

  test('false for a button-only device (incl. multi-instance button.x)', () => {
    assert.equal(scanner.canCheckStaleness(device({ capabilities: ['button'] })), false);
    assert.equal(scanner.canCheckStaleness(device({ capabilities: ['button', 'button.2'] })), false);
  });

  test('false for a device with no capabilities at all', () => {
    assert.equal(scanner.canCheckStaleness(device({ capabilities: [], capabilitiesObj: {} })), false);
  });

  test('falls back to capabilitiesObj keys when capabilities is not populated', () => {
    assert.equal(scanner.canCheckStaleness({ capabilitiesObj: { onoff: { value: true } } }), true);
    assert.equal(scanner.canCheckStaleness({ capabilitiesObj: { button: { value: null } } }), false);
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

  test('a device with a real capability but no data yet is treated as not reporting', () => {
    // Genuine "dead sensor" case: it has a capability that would carry a timestamp, it
    // just never has - still flagged, exactly as before.
    const d = device({ capabilities: ['measure_temperature'], capabilitiesObj: {} });
    const status = scanner.computeDeviceStatus(d, null, config);
    assert.equal(status.isReporting, false);
  });

  test('a device whose only capability is button is never flagged not reporting', () => {
    // Virtual "button" / scene-trigger device (e.g. com.arjankranenburg.virtual): the
    // button capability never carries a lastUpdated, so the staleness check is skipped
    // entirely rather than flagging it forever.
    const d = device({ class: 'button', capabilities: ['button'], capabilitiesObj: { button: { value: null } } });
    const status = scanner.computeDeviceStatus(d, null, config);
    assert.equal(status.isReporting, true);
  });

  test('a real button device with a battery capability is still staleness-checked', () => {
    // A physical remote/button (Aqara, IKEA, ...) has measure_battery alongside button -
    // that one CAN carry a timestamp, so a genuinely silent one is still flagged.
    const d = device({
      class: 'button',
      capabilities: ['button', 'measure_battery'],
      capabilitiesObj: { measure_battery: { value: 80, lastUpdated: new Date(Date.now() - 25 * HOUR).toISOString() } },
    });
    const status = scanner.computeDeviceStatus(d, null, config);
    assert.equal(status.isReporting, false);
  });

  test('a device with no capabilities at all is not flagged not reporting', () => {
    const d = device({ capabilities: [], capabilitiesObj: {} });
    const status = scanner.computeDeviceStatus(d, null, config);
    assert.equal(status.isReporting, true);
  });

  test('a stale capability with a fresh lastSeenAt is still not reporting by default', () => {
    const d = device({
      capabilitiesObj: { onoff: { value: true, lastUpdated: new Date(Date.now() - 25 * HOUR).toISOString() } },
      lastSeenAt: new Date(Date.now() - 60000).toISOString(),
    });
    const status = scanner.computeDeviceStatus(d, null, config);
    assert.equal(status.isReporting, false);
  });

  test('includeLastSeenForReporting treats a fresh lastSeenAt as a sign of life', () => {
    const d = device({
      capabilitiesObj: { onoff: { value: true, lastUpdated: new Date(Date.now() - 25 * HOUR).toISOString() } },
      lastSeenAt: new Date(Date.now() - 60000).toISOString(),
    });
    const status = scanner.computeDeviceStatus(d, null, { ...config, includeLastSeenForReporting: true });
    assert.equal(status.isReporting, true);
  });

  test('includeLastSeenForReporting does not help if lastSeenAt is also stale', () => {
    const d = device({
      capabilitiesObj: { onoff: { value: true, lastUpdated: new Date(Date.now() - 25 * HOUR).toISOString() } },
      lastSeenAt: new Date(Date.now() - 26 * HOUR).toISOString(),
    });
    const status = scanner.computeDeviceStatus(d, null, { ...config, includeLastSeenForReporting: true });
    assert.equal(status.isReporting, false);
  });

  test('a per-device includeLastSeenForReporting override of true wins over a global false', () => {
    const d = device({
      capabilitiesObj: { onoff: { value: true, lastUpdated: new Date(Date.now() - 25 * HOUR).toISOString() } },
      lastSeenAt: new Date(Date.now() - 60000).toISOString(),
    });
    const status = scanner.computeDeviceStatus(d, { includeLastSeenForReporting: true }, config);
    assert.equal(status.isReporting, true);
  });

  test('a per-device includeLastSeenForReporting override of false wins over a global true', () => {
    const d = device({
      capabilitiesObj: { onoff: { value: true, lastUpdated: new Date(Date.now() - 25 * HOUR).toISOString() } },
      lastSeenAt: new Date(Date.now() - 60000).toISOString(),
    });
    const status = scanner.computeDeviceStatus(
      d, { includeLastSeenForReporting: false }, { ...config, includeLastSeenForReporting: true },
    );
    assert.equal(status.isReporting, false);
  });

  test('a per-device includeLastSeenForReporting of null inherits the global setting', () => {
    const d = device({
      capabilitiesObj: { onoff: { value: true, lastUpdated: new Date(Date.now() - 25 * HOUR).toISOString() } },
      lastSeenAt: new Date(Date.now() - 60000).toISOString(),
    });
    const status = scanner.computeDeviceStatus(
      d, { includeLastSeenForReporting: null }, { ...config, includeLastSeenForReporting: true },
    );
    assert.equal(status.isReporting, true);
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

describe('isRulePaused', () => {
  test('a future pausedUntil date is paused', () => {
    const future = new Date(Date.now() + 24 * HOUR).toISOString().slice(0, 10);
    assert.equal(scanner.isRulePaused({ pausedUntil: future }), true);
  });

  test('a past pausedUntil date is not paused', () => {
    const past = new Date(Date.now() - 48 * HOUR).toISOString().slice(0, 10);
    assert.equal(scanner.isRulePaused({ pausedUntil: past }), false);
  });

  test('pausedUntil of today (the boundary day) is still paused until end of day', () => {
    const today = new Date().toISOString().slice(0, 10);
    assert.equal(scanner.isRulePaused({ pausedUntil: today }), true);
  });

  test('null/missing pausedUntil is not paused', () => {
    assert.equal(scanner.isRulePaused({}), false);
    assert.equal(scanner.isRulePaused(null), false);
  });

  test('an unparsable pausedUntil is treated as not paused, not thrown', () => {
    assert.equal(scanner.isRulePaused({ pausedUntil: 'not-a-date' }), false);
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

  test('a button-only virtual device never lands in notReporting', () => {
    const devices = {
      btn: device({
        id: 'btn',
        name: 'Scene button',
        class: 'button',
        capabilities: ['button'],
        capabilitiesObj: { button: { value: null } },
      }),
    };

    const result = scanner.runScan({
      devices, zones, rules: [], config,
    });

    assert.equal(result.notReporting.length, 0);
    assert.equal(result.all.find((d) => d.id === 'btn').status, 'OK');
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

  test('a rule with a future pausedUntil removes the device from every list, like excludeAll', () => {
    const devices = {
      pausedDev: device({ id: 'pausedDev', name: 'Paused device' }),
    };
    const future = new Date(Date.now() + 24 * HOUR).toISOString().slice(0, 10);
    const rules = [{
      id: 'r1', matchType: 'id', matchValue: 'pausedDev', pausedUntil: future,
    }];

    const result = scanner.runScan({
      devices, zones, rules, config,
    });

    assert.equal(result.all.length, 0);
    assert.equal(result.excluded.length, 1);
    assert.equal(result.excluded[0].reason, 'paused');
  });

  test('a rule with a past pausedUntil no longer excludes the device (self-resolving)', () => {
    const devices = {
      dev: device({
        id: 'dev',
        capabilitiesObj: { onoff: { value: true, lastUpdated: new Date().toISOString() } },
      }),
    };
    const past = new Date(Date.now() - 48 * HOUR).toISOString().slice(0, 10);
    const rules = [{
      id: 'r1', matchType: 'id', matchValue: 'dev', pausedUntil: past,
    }];

    const result = scanner.runScan({
      devices, zones, rules, config,
    });

    assert.equal(result.all.length, 1);
    assert.equal(result.excluded.length, 0);
  });
});
