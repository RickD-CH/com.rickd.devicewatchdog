'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

// The device class needs the Homey runtime ('homey') - stand in for it just long enough to load it.
const realLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request === 'homey') return { Device: class {} };
  return realLoad.call(this, request, ...rest);
};
const WatchdogDevice = require('../drivers/watchdog/device');

Module._load = realLoad;

// A virtual Watchdog device without Homey: capability values live in a plain object.
function makeDevice({ capabilities = [], values = {}, app = {} } = {}) {
  const device = Object.create(WatchdogDevice.prototype);
  const has = new Set(capabilities);
  const listeners = {};
  const log = { added: [], errors: [], scans: [] };

  device.hasCapability = (id) => has.has(id);
  device.addCapability = async (id) => {
    has.add(id);
    log.added.push(id);
  };
  device.getCapabilityValue = (id) => (has.has(id) ? values[id] ?? null : null);
  device.setCapabilityValue = async (id, value) => {
    values[id] = value;
  };
  device.registerCapabilityListener = (id, fn) => {
    listeners[id] = fn;
  };
  device.log = () => {};
  device.error = (...args) => log.errors.push(args);
  device.homey = {
    app: {
      config: {},
      lastScan: null,
      flagState: null,
      _countUnavailable: () => 0,
      _countProblemDevices: () => 0,
      _latestProblemDeviceName: () => null,
      runScan: async (source) => {
        log.scans.push(source);
      },
      ...app,
    },
  };
  return {
    device, values, listeners, log, has,
  };
}

const ALL = [
  'alarm_generic', 'devices_problem_count', 'devices_latest_problem',
  'devices_not_reporting_count', 'devices_unavailable_count', 'devices_low_battery_count', 'scan_now',
];

describe('virtual Watchdog device: "Latest problem device"', () => {
  test('shows the name it is given and "-" when nothing is wrong', async () => {
    const { device, values } = makeDevice({ capabilities: ALL });
    device._counts = {
      problem: 0, notReporting: 0, unavailable: 0, lowBattery: 0, latest: '-',
    };
    device.homey.app.config = {};

    await device.updateCounts({ problemCount: 1, latestProblemName: 'Kitchen sensor' });
    assert.equal(values.devices_latest_problem, 'Kitchen sensor');
    assert.equal(values.devices_problem_count, 1);

    await device.updateCounts({ problemCount: 0, latestProblemName: null });
    assert.equal(values.devices_latest_problem, '-');
  });

  test('keeps the current name when none is given (not known yet / a plain count update)', async () => {
    const { device, values } = makeDevice({ capabilities: ALL });
    device._counts = {
      problem: 1, notReporting: 0, unavailable: 1, lowBattery: 0, latest: 'Kitchen sensor',
    };

    await device.updateCounts({ unavailableCount: 2 });
    assert.equal(values.devices_latest_problem, 'Kitchen sensor');

    await device.updateCounts({ latestProblemName: undefined });
    assert.equal(values.devices_latest_problem, 'Kitchen sensor');
  });

  test('starts from the stored value after a restart', async () => {
    const { device } = makeDevice({
      capabilities: ALL,
      values: { devices_latest_problem: 'Garage door' },
      app: { _latestProblemDeviceName: () => undefined },
    });
    await device.onInit();
    assert.equal(device._counts.latest, 'Garage door', 'no name known yet right after the start: keep what was shown');
  });

  test('starts with "-" for a brand new device', async () => {
    const { device, values } = makeDevice({ capabilities: ALL });
    await device.onInit();
    assert.equal(values.devices_latest_problem, '-');
  });
});

describe('virtual Watchdog device: "Scan now" button', () => {
  test('pressing it starts a scan and does not wait for it', async () => {
    let finishScan;
    const scanning = new Promise((resolve) => {
      finishScan = resolve;
    });
    const { device, listeners, log } = makeDevice({
      capabilities: ALL,
      app: {
        runScan: async (source) => {
          log.scans.push(source);
          await scanning;
        },
      },
    });
    await device.onInit();

    await listeners.scan_now(true); // resolves although the scan is still running
    assert.deepEqual(log.scans, ['virtual-device']);
    finishScan();
  });

  test('a failing scan is logged, the button press itself does not fail', async () => {
    const { device, listeners, log } = makeDevice({
      capabilities: ALL,
      app: {
        runScan: async () => {
          throw new Error('API down');
        },
      },
    });
    await device.onInit();

    await listeners.scan_now(true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(log.errors.length, 1);
    assert.match(String(log.errors[0][1]), /API down/);
  });
});

describe('virtual Watchdog device: capabilities of an already added device', () => {
  test('a device from 1.9.60 gets the new field and the button added at the end', async () => {
    const { device, log, has } = makeDevice({
      capabilities: ['alarm_generic', 'devices_problem_count', 'devices_not_reporting_count', 'devices_unavailable_count', 'devices_low_battery_count'],
    });
    await device.onInit();

    assert.deepEqual(log.added, ['devices_latest_problem', 'scan_now']);
    assert.ok(has.has('scan_now'));
  });

  test('a device that already has everything is left alone', async () => {
    const { device, log } = makeDevice({ capabilities: ALL });
    await device.onInit();
    assert.deepEqual(log.added, []);
  });

  test('without the button capability no listener is registered (and nothing breaks)', async () => {
    const { device, listeners } = makeDevice({ capabilities: ALL.filter((id) => id !== 'scan_now') });
    device.addCapability = async () => {
      throw new Error('cannot add');
    };
    await device.onInit();
    assert.equal(listeners.scan_now, undefined);
  });
});
