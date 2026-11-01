'use strict';

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

// app.js needs the Homey runtime ('homey') - stand in for it just long enough to load the class.
const realLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request === 'homey') return { App: class {} };
  if (request === 'homey-api') return { HomeyAPI: {} };
  return realLoad.call(this, request, ...rest);
};
const DeviceWatchdogApp = require('../app');

Module._load = realLoad;

const scanner = require('../lib/scanner');
const { DEFAULT_CONFIG } = require('../lib/defaults');

const en = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'locales', 'en.json'), 'utf8'));

const realDateNow = Date.now;
// File-level on purpose: every test below fakes the clock through makeApp(), none may leak it.
// eslint-disable-next-line mocha/no-top-level-hooks
afterEach(() => {
  Date.now = realDateNow;
});

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const BASE = 1.8e12;

// A DeviceWatchdogApp instance without Homey: enough state for the methods under test, a fake
// clock (Date.now) and a fake scheduler (homey.setTimeout) that only moves when advance() is called.
function makeApp(configOverrides = {}) {
  let now = 0;
  const timers = [];
  const timeline = [];
  const calls = {
    watchdogDevice: [], scans: [], settings: [], events: [],
  };
  Date.now = () => BASE + now;

  const app = Object.create(DeviceWatchdogApp.prototype);
  app.config = { ...DEFAULT_CONFIG, timelineNotifications: true, ...configOverrides };
  app.homey = {
    manifest: { id: 'com.rickd.devicewatchdog' },
    clock: { getTimezone: () => 'Europe/Zurich' },
    setTimeout: (fn, ms) => {
      const timer = { fn, at: now + ms }; timers.push(timer); return timer;
    },
    clearTimeout: (timer) => {
      if (timer) timer.cancelled = true;
    },
    setInterval: () => ({}),
    clearInterval: () => {},
    settings: { set: (key, value) => calls.settings.push([key, value]) },
    notifications: {
      createNotification: async ({ excerpt }) => {
        timeline.push(excerpt);
      },
    },
    drivers: {
      getDriver() {
        throw new Error('no virtual device in tests');
      },
    },
    __: (key, vars) => {
      let text = key.split('.').reduce((o, k) => (o ? o[k] : undefined), en);
      Object.entries(vars || {}).forEach(([k, v]) => {
        text = text.split(`__${k}__`).join(v);
      });
      return text;
    },
  };
  app.error = () => {};
  app.log = () => {};
  app._globalPauseTimer = null;
  app._startupGraceTimer = null;
  app._intervalTimer = null;
  app._ruleIndex = scanner.buildRuleIndex([]);
  app.rules = [];
  app._zoneMap = {};
  app._availabilityMap = new Map();
  app._confirmedUnavailable = new Set();
  app._pendingUnavailableTimers = new Map();
  app._unavailableBatch = new Set();
  app._unavailableBatchTimer = null;
  app._availableAgainBatch = new Map();
  app._availableAgainBatchTimer = null;
  app._unavailableStartedAt = new Map();
  app.problemSince = { unavailable: {}, notReporting: {}, lowBattery: {} };
  app.flagState = { notReporting: [], lowBattery: [], lowBatteryConfirmed: [] };
  app._recordEvent = (type, data) => calls.events.push([type, data && data.device]);
  app._recordUpdateStat = () => {};
  app._updateWatchdogDevice = async (counts) => {
    calls.watchdogDevice.push(counts);
  };
  app.runScan = async (source) => {
    calls.scans.push(source);
  };
  app._triggerUnavailable = null;
  app._triggerUnavailableSummary = null;
  app._triggerAvailableAgainSummary = null;

  const advance = (ms) => {
    const end = now + ms;
    for (;;) {
      const due = timers.filter((t) => !t.cancelled && !t.done && t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      now = due.at;
      due.done = true;
      due.fn();
    }
    now = end;
  };

  return {
    app, advance, timeline, calls, timers, nowMs: () => BASE + now,
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const device = (id, name, available) => ({ id, name, available });

describe('timeline notifications', () => {
  test('nothing is written while the master switch is off', () => {
    const { app, timeline } = makeApp({ timelineNotifications: false });
    app._notifyTimeline('x', 'unavailable');
    assert.deepEqual(timeline, []);
  });

  test('with all categories on (the default) every kind of entry is written', async () => {
    const { app, timeline } = makeApp();
    ['unavailable', 'notReporting', 'lowBattery'].forEach((category) => app._notifyTimeline(category, category));
    await flush();
    assert.deepEqual(timeline, ['unavailable', 'notReporting', 'lowBattery']);
  });

  test('a category that is switched off is filtered, the others still go through', async () => {
    const { app, timeline } = makeApp({ timelineIncludesNotReporting: false, timelineIncludesLowBattery: false });
    ['unavailable', 'notReporting', 'lowBattery'].forEach((category) => app._notifyTimeline(category, category));
    await flush();
    assert.deepEqual(timeline, ['unavailable']);
  });

  test('a config saved before the per-category switches existed behaves like "all on"', async () => {
    const { app, timeline } = makeApp();
    delete app.config.timelineIncludesNotReporting;
    app._notifyTimeline('nr', 'notReporting');
    await flush();
    assert.deepEqual(timeline, ['nr']);
  });
});

describe('unavailable devices and the timeline', () => {
  test('an outage shorter than the delay never shows up at all', () => {
    const { app, advance, timeline } = makeApp({ unavailableDelaySeconds: 10 });
    app._availabilityMap.set('airco', true);
    app._handleDeviceUpdate(device('airco', 'Airco', false));
    advance(5 * SECOND);
    app._handleDeviceUpdate(device('airco', 'Airco', true));
    advance(30 * SECOND);
    assert.deepEqual(timeline, []);
    assert.equal(app._unavailableStartedAt.size, 0);
  });

  test('a longer outage writes two entries (each ~3 s after its event) and names the duration', () => {
    const { app, advance, timeline } = makeApp({ unavailableDelaySeconds: 10 });
    app._availabilityMap.set('airco', true);
    app._handleDeviceUpdate(device('airco', 'Airco', false));
    advance(11 * SECOND);
    app._handleDeviceUpdate(device('airco', 'Airco', true));
    advance(10 * SECOND);
    assert.equal(timeline.length, 2);
    assert.equal(timeline[0], '🔌 1 device(s) unavailable: Airco');
    assert.equal(timeline[1], '🟢 1 device(s) available again: Airco (after 11 s)');
  });

  test('several devices coming back together are listed with their own durations', () => {
    const { app, advance, timeline } = makeApp();
    app._availabilityMap.set('a', true);
    app._availabilityMap.set('b', true);
    app._handleDeviceUpdate(device('a', 'Airco', false));
    app._handleDeviceUpdate(device('b', 'Plug', false));
    advance(40 * SECOND);
    app._handleDeviceUpdate(device('a', 'Airco', true));
    advance(1 * SECOND);
    app._handleDeviceUpdate(device('b', 'Plug', true));
    advance(10 * SECOND);
    assert.ok(timeline[timeline.length - 1].endsWith('Airco (after 40 s), Plug (after 41 s)'));
  });

  test('the Flow token of the "available again" summary stays plain names', () => {
    const { app, advance } = makeApp();
    const tokens = [];
    app._triggerAvailableAgainSummary = {
      trigger: (t) => {
        tokens.push(t); return Promise.resolve();
      },
    };
    app._availabilityMap.set('airco', true);
    app._handleDeviceUpdate(device('airco', 'Airco', false));
    advance(20 * SECOND);
    app._handleDeviceUpdate(device('airco', 'Airco', true));
    advance(10 * SECOND);
    assert.deepEqual(tokens.map((t) => t.devices), ['Airco']);
  });

  test('a device that was already down when the app started has no known duration', () => {
    const { app, advance, timeline } = makeApp();
    app._availabilityMap.set('airco', false);
    app._confirmedUnavailable.add('airco');
    app._handleDeviceUpdate(device('airco', 'Airco', true));
    advance(10 * SECOND);
    assert.equal(timeline[0], '🟢 1 device(s) available again: Airco');
  });

  test('"available again" respects the unavailable category switch', () => {
    const { app, advance, timeline } = makeApp({ timelineIncludesUnavailable: false });
    app._availabilityMap.set('airco', true);
    app._handleDeviceUpdate(device('airco', 'Airco', false));
    advance(20 * SECOND);
    app._handleDeviceUpdate(device('airco', 'Airco', true));
    advance(10 * SECOND);
    assert.deepEqual(timeline, []);
  });
});

describe('global pause', () => {
  test('isGloballyPaused is only true for a future timestamp', () => {
    const { app, nowMs } = makeApp();
    assert.equal(app.isGloballyPaused(), false);
    app.config.globalPausedUntilMs = nowMs() + HOUR;
    assert.equal(app.isGloballyPaused(), true);
    app.config.globalPausedUntilMs = nowMs() - 1;
    assert.equal(app.isGloballyPaused(), false);
    app.config.globalPausedUntilMs = 'tomorrow';
    assert.equal(app.isGloballyPaused(), false);
  });

  test('while paused every device counts as not monitored and excluded from "unavailable", even without a rule', () => {
    const { app, nowMs } = makeApp();
    assert.equal(app._isMonitored('any'), true);
    assert.equal(app._isExcludedFromUnavailable('any'), false);
    app.config.globalPausedUntilMs = nowMs() + HOUR;
    assert.equal(app._isMonitored('any'), false);
    assert.equal(app._isExcludedFromUnavailable('any'), true);
  });

  test('pauseGlobalFor stores the end time, persists it, arms the timer and refreshes once', async () => {
    const {
      app, calls, timers, nowMs,
    } = makeApp();
    const before = nowMs();
    await app.pauseGlobalFor(2, 'hours');

    assert.equal(app.config.globalPausedUntilMs, before + 2 * HOUR);
    assert.equal(app.isGloballyPaused(), true);
    assert.ok(calls.settings.some(([key, value]) => key === 'config' && value.globalPausedUntilMs === before + 2 * HOUR));
    assert.equal(timers.filter((t) => !t.cancelled).length, 1);
    assert.deepEqual(calls.watchdogDevice, [{ unavailableCount: 0 }]);
    assert.deepEqual(calls.scans, ['pause']);
  });

  test('pauseGlobalFor in minutes', async () => {
    const { app, nowMs } = makeApp();
    const before = nowMs();
    await app.pauseGlobalFor('30', 'minutes');
    assert.equal(app.config.globalPausedUntilMs, before + 30 * MINUTE);
  });

  test('a pause that is not a positive amount is rejected and changes nothing', async () => {
    const { app, calls } = makeApp();
    for (const bad of [0, -5, 'abc', null, undefined, NaN]) {
      await assert.rejects(() => app.pauseGlobalFor(bad, 'hours'), /Invalid pause/);
    }
    assert.equal(app.config.globalPausedUntilMs, null);
    assert.deepEqual(calls.scans, []);
  });

  test('pauseGlobalUntilTime pauses until the next occurrence of that time on the Homey clock', async () => {
    const { app, nowMs } = makeApp();
    const before = nowMs();
    await app.pauseGlobalUntilTime('06:00');
    const ms = app.config.globalPausedUntilMs - before;
    assert.ok(ms > 0 && ms <= 24 * HOUR);
    // 06:00 Zurich time, whatever "now" is
    const hourInZurich = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Zurich', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(new Date(app.config.globalPausedUntilMs));
    assert.equal(hourInZurich, '06:00');
  });

  test('pauseGlobalUntilTime rejects something that is not a time', async () => {
    const { app } = makeApp();
    await assert.rejects(() => app.pauseGlobalUntilTime('later'), /Invalid pause/);
    assert.equal(app.config.globalPausedUntilMs, null);
  });

  test('resumeGlobal ends the pause, disarms the timer and refreshes', async () => {
    const { app, calls, timers } = makeApp();
    await app.pauseGlobalFor(1, 'hours');
    calls.scans.length = 0;
    calls.watchdogDevice.length = 0;

    await app.resumeGlobal();

    assert.equal(app.config.globalPausedUntilMs, null);
    assert.equal(app.isGloballyPaused(), false);
    assert.equal(timers.filter((t) => !t.cancelled).length, 0);
    assert.deepEqual(calls.scans, ['pause']);
    assert.equal(calls.watchdogDevice.length, 1);
  });

  test('resumeGlobal does nothing when Watchdog is not paused', async () => {
    const { app, calls } = makeApp();
    await app.resumeGlobal();
    assert.deepEqual(calls.scans, []);
    assert.deepEqual(calls.watchdogDevice, []);
  });

  test('the pause ends by itself when the time is up, with one refresh', async () => {
    const { app, advance, calls } = makeApp();
    await app.pauseGlobalFor(10, 'minutes');
    calls.scans.length = 0;

    advance(9 * MINUTE);
    await flush();
    assert.equal(app.isGloballyPaused(), true);
    assert.deepEqual(calls.scans, []);

    advance(2 * MINUTE);
    await flush();
    assert.equal(app.isGloballyPaused(), false);
    assert.equal(app.config.globalPausedUntilMs, null);
    assert.deepEqual(calls.scans, ['pause']);
  });

  test('a pause that already ran out while the app was off is just cleared, without a scan', () => {
    const { app, calls, nowMs } = makeApp({ globalPausedUntilMs: BASE - HOUR });
    assert.ok(nowMs() > app.config.globalPausedUntilMs);
    app._scheduleGlobalPauseEnd();
    assert.equal(app.config.globalPausedUntilMs, null);
    assert.deepEqual(calls.scans, []);
  });

  test('a pause still running after a restart of the app re-arms its timer', () => {
    const { app, timers, nowMs } = makeApp();
    app.config.globalPausedUntilMs = nowMs() + 3 * HOUR;
    app._scheduleGlobalPauseEnd();
    assert.equal(timers.filter((t) => !t.cancelled).length, 1);
    assert.equal(app.isGloballyPaused(), true);
  });

  test('a pause longer than the timer limit re-arms instead of ending early', async () => {
    const {
      app, advance, timers, nowMs,
    } = makeApp();
    const sixtyDays = 60 * 24 * HOUR;
    app.config.globalPausedUntilMs = nowMs() + sixtyDays;
    app._scheduleGlobalPauseEnd();
    assert.ok(timers[0].at <= 2147483647, 'first timer is capped');

    advance(2147483647);
    await flush();
    assert.equal(app.isGloballyPaused(), true, 'still paused after the first timer');
    assert.equal(timers.filter((t) => !t.cancelled && !t.done).length, 1, 'a new timer is armed');
  });

  test('a device\'s own, longer pause is untouched by the global pause and still applies after it ends', async () => {
    const { app, nowMs } = makeApp();
    const local = (ms) => {
      const d = new Date(ms);
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };
    const rules = [{
      id: 'r1', matchType: 'id', matchValue: 'seasonal', pausedUntil: local(nowMs() + 72 * HOUR),
    }];
    app.rules = rules;
    app._ruleIndex = scanner.buildRuleIndex(rules);

    assert.equal(app._isMonitored('seasonal'), false, 'paused on its own');
    assert.equal(app._isMonitored('other'), true);

    await app.pauseGlobalFor(1, 'hours');
    assert.equal(app._isMonitored('seasonal'), false);
    assert.equal(app._isMonitored('other'), false, 'global pause covers everything');
    assert.equal(app.rules[0].pausedUntil, rules[0].pausedUntil, 'the device\'s own rule is not rewritten');

    await app.resumeGlobal();
    assert.equal(app._isMonitored('seasonal'), false, 'its own pause keeps running');
    assert.equal(app._isMonitored('other'), true, 'everything else is monitored again');
  });

  test('saving the settings keeps a running pause, even if the posted config does not mention it', async () => {
    const { app, nowMs } = makeApp();
    const until = nowMs() + HOUR;
    app.config.globalPausedUntilMs = until;

    await app.saveConfig({ config: { scanIntervalMinutes: 30 } });
    assert.equal(app.config.globalPausedUntilMs, until);
    assert.equal(app.config.scanIntervalMinutes, 30);

    await app.saveConfig({ config: { scanIntervalMinutes: 30, globalPausedUntilMs: null } });
    assert.equal(app.config.globalPausedUntilMs, until, 'a posted value cannot change it');
  });

  test('"reset to factory settings" also ends a running pause', async () => {
    const { app, nowMs, timers } = makeApp();
    app.config.globalPausedUntilMs = nowMs() + HOUR;
    app._scheduleGlobalPauseEnd();

    await app.resetSettings();

    assert.equal(app.config.globalPausedUntilMs, null);
    assert.equal(timers.filter((t) => !t.cancelled && !t.done).length, 0);
  });
});

describe('flagged state across a pause (_fireEdgeTriggers)', () => {
  const entry = (id, name) => ({
    id, name, zone: null, lastUpdated: '2026-01-01 10:00', battery: null, status: 'NOK',
  });
  const scan = ({
    all = [], notReporting = [], lowBattery = [], excluded = [],
  }) => ({
    all, notReporting, lowBattery, excluded, generatedAt: new Date().toISOString(),
  });

  function appWithFlagged() {
    const ctx = makeApp();
    ctx.app.flagState = { notReporting: ['a'], lowBattery: [], lowBatteryConfirmed: [] };
    ctx.app.problemSince.notReporting.a = BASE - HOUR;
    ctx.app._notifyTimeline = (text, category) => ctx.timeline.push(`${category}: ${text}`);
    return ctx;
  }

  test('a device that is only paused keeps its flagged state, with no recovery reported', async () => {
    const { app, timeline, calls } = appWithFlagged();

    await app._fireEdgeTriggers(scan({ excluded: [{ id: 'a', name: 'A', reason: 'paused' }] }));

    assert.deepEqual(app.flagState.notReporting, ['a']);
    assert.ok('a' in app.problemSince.notReporting, '"since" is kept');
    assert.deepEqual(timeline, []);
    assert.deepEqual(calls.events, []);
  });

  test('after the pause the same still-flagged device is NOT announced as newly found again', async () => {
    const { app, timeline, calls } = appWithFlagged();
    await app._fireEdgeTriggers(scan({ excluded: [{ id: 'a', name: 'A', reason: 'paused' }] }));

    const a = entry('a', 'A');
    await app._fireEdgeTriggers(scan({ all: [a], notReporting: [a] }));

    assert.deepEqual(timeline, []);
    assert.deepEqual(calls.events, []);
    assert.deepEqual(app.flagState.notReporting, ['a']);
  });

  test('a device that healed during the pause is reported as reporting again afterwards', async () => {
    const { app, timeline, calls } = appWithFlagged();
    await app._fireEdgeTriggers(scan({ excluded: [{ id: 'a', name: 'A', reason: 'paused' }] }));

    const healed = { ...entry('a', 'A'), status: 'OK' };
    await app._fireEdgeTriggers(scan({ all: [healed] }));

    assert.equal(timeline.length, 1);
    assert.ok(timeline[0].startsWith('notReporting: '));
    assert.deepEqual(calls.events, [['notReportingRecovered', 'A']]);
    assert.deepEqual(app.flagState.notReporting, []);
  });

  test('a device excluded outright ("monitored" off) still drops out of the flagged state', async () => {
    const { app } = appWithFlagged();
    await app._fireEdgeTriggers(scan({ excluded: [{ id: 'a', name: 'A', reason: 'excludeAll' }] }));
    assert.deepEqual(app.flagState.notReporting, []);
  });

  test('a device that is new while another is paused is still announced', async () => {
    const { app, timeline } = appWithFlagged();
    const b = entry('b', 'B');
    await app._fireEdgeTriggers(scan({
      all: [b], notReporting: [b], excluded: [{ id: 'a', name: 'A', reason: 'paused' }],
    }));
    assert.equal(timeline.length, 1);
    assert.deepEqual(app.flagState.notReporting.sort(), ['a', 'b']);
  });

  test('the virtual device counts confirmed low batteries without the paused ones', async () => {
    const { app, calls } = appWithFlagged();
    app.flagState = { notReporting: [], lowBattery: ['b', 'c'], lowBatteryConfirmed: ['b', 'c'] };

    await app._fireEdgeTriggers(scan({ excluded: [{ id: 'b', name: 'B', reason: 'paused' }, { id: 'c', name: 'C', reason: 'paused' }] }));
    assert.deepEqual(calls.watchdogDevice.pop(), { lowBatteryCount: 0 });

    app.flagState = { notReporting: [], lowBattery: ['b', 'c'], lowBatteryConfirmed: ['b', 'c'] };
    const c = { ...entry('c', 'C'), battery: '10%' };
    await app._fireEdgeTriggers(scan({ all: [c], lowBattery: [c], excluded: [{ id: 'b', name: 'B', reason: 'paused' }] }));
    assert.deepEqual(calls.watchdogDevice.pop(), { lowBatteryCount: 1 });
  });
});
