'use strict';

const Homey = require('homey');
const { HomeyAPI } = require('homey-api');
const { DEFAULT_CONFIG, DEFAULT_RULES } = require('./lib/defaults');
const scanner = require('./lib/scanner');

const SETTINGS_KEY_CONFIG = 'config';
const SETTINGS_KEY_RULES = 'rules';
const SETTINGS_KEY_FLAG_STATE = 'flagState';
const SETTINGS_KEY_LAST_SCAN = 'lastScan';

function generateId() {
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

class DeviceWatchdogApp extends Homey.App {

  async onInit() {
    this.log('Device Watchdog initialized');

    this.config = { ...DEFAULT_CONFIG, ...(this.homey.settings.get(SETTINGS_KEY_CONFIG) || {}) };
    this.rules = this.homey.settings.get(SETTINGS_KEY_RULES) || DEFAULT_RULES;
    this.flagState = this.homey.settings.get(SETTINGS_KEY_FLAG_STATE) || { notReporting: [], lowBattery: [] };
    this.lastScan = this.homey.settings.get(SETTINGS_KEY_LAST_SCAN) || null;

    this._zoneMap = {};
    this._availabilityMap = new Map();
    this._intervalTimer = null;
    this._scanPromise = null;

    this._registerFlowCards();

    try {
      this.api = await HomeyAPI.createAppAPI({ homey: this.homey });
      await this._primeAvailabilityMap();
      await this._connectRealtime();
    } catch (err) {
      this._apiInitError = err;
      this.error('Konnte HomeyAPI nicht initialisieren:', err);
    }

    this._scheduleInterval({ runImmediately: true });
  }

  // ---------------------------------------------------------------------
  // Flow cards
  // ---------------------------------------------------------------------

  _registerFlowCards() {
    this.homey.flow.getActionCard('run_scan').registerRunListener(async () => {
      await this.runScan('flow');
      return true;
    });

    this._triggerNotReporting = this.homey.flow.getTriggerCard('device_not_reporting');
    this._triggerBatteryLow = this.homey.flow.getTriggerCard('device_battery_low');
    this._triggerUnavailable = this.homey.flow.getTriggerCard('device_unavailable');
  }

  // ---------------------------------------------------------------------
  // Realtime availability (instant "device_unavailable" trigger)
  // ---------------------------------------------------------------------

  async _primeAvailabilityMap() {
    const devices = await this.api.devices.getDevices();
    const zones = await this.api.zones.getZones();
    this._zoneMap = Object.fromEntries(Object.values(zones).map((z) => [z.id, z.name]));

    this._availabilityMap.clear();
    for (const device of Object.values(devices)) {
      this._availabilityMap.set(device.id, device.available !== false);
    }
  }

  async _connectRealtime() {
    await this.api.devices.connect();
    this.api.devices.on('device.update', (device) => this._handleDeviceUpdate(device));
  }

  _handleDeviceUpdate(device) {
    if (!device || !device.id) return;

    const wasAvailable = this._availabilityMap.get(device.id);
    const isAvailable = device.available !== false;
    this._availabilityMap.set(device.id, isAvailable);

    if (wasAvailable === true && isAvailable === false) {
      const zoneName = device.zone ? (this._zoneMap[device.zone] || '') : '';
      this._triggerUnavailable
        ?.trigger({ device: device.name || '', zone: zoneName || '' })
        .catch((err) => this.error('Trigger device_unavailable fehlgeschlagen:', err));
    }
  }

  // ---------------------------------------------------------------------
  // Interval scheduling
  // ---------------------------------------------------------------------

  _scheduleInterval({ runImmediately = false } = {}) {
    if (this._intervalTimer) {
      this.homey.clearInterval(this._intervalTimer);
      this._intervalTimer = null;
    }

    if (this.config.scanIntervalEnabled && this.config.scanIntervalMinutes > 0) {
      const ms = this.config.scanIntervalMinutes * 60 * 1000;
      this._intervalTimer = this.homey.setInterval(() => {
        this.runScan('interval').catch((err) => this.error('Intervall-Scan fehlgeschlagen:', err));
      }, ms);

      if (runImmediately) {
        this.runScan('interval').catch((err) => this.error('Initial-Scan fehlgeschlagen:', err));
      }
    }
  }

  // ---------------------------------------------------------------------
  // Config / rules (used by api.js)
  // ---------------------------------------------------------------------

  getConfig() {
    return { config: this.config, rules: this.rules };
  }

  async saveConfig({ config, rules } = {}) {
    if (config && typeof config === 'object') {
      this.config = { ...DEFAULT_CONFIG, ...config };
      this.homey.settings.set(SETTINGS_KEY_CONFIG, this.config);
    }

    if (Array.isArray(rules)) {
      this.rules = rules.map((rule) => ({
        id: rule.id || generateId(),
        matchType: rule.matchType,
        matchValue: rule.matchValue,
        label: rule.label || '',
        notReportingDays: rule.notReportingDays === '' || rule.notReportingDays === undefined
          ? null : Number(rule.notReportingDays),
        batteryThreshold: rule.batteryThreshold === '' || rule.batteryThreshold === undefined
          ? null : Number(rule.batteryThreshold),
        excludeBattery: !!rule.excludeBattery,
        onlyCheckBattery: !!rule.onlyCheckBattery,
        excludeAll: !!rule.excludeAll,
      }));
      this.homey.settings.set(SETTINGS_KEY_RULES, this.rules);
    }

    this._scheduleInterval({ runImmediately: false });

    return this.getConfig();
  }

  // ---------------------------------------------------------------------
  // Devices / status (used by api.js)
  // ---------------------------------------------------------------------

  async _ensureApi() {
    if (this.api) return this.api;

    try {
      this.api = await HomeyAPI.createAppAPI({ homey: this.homey });
      this._apiInitError = null;
      await this._primeAvailabilityMap();
      await this._connectRealtime();
    } catch (err) {
      this._apiInitError = err;
      this.error('HomeyAPI-Initialisierung erneut fehlgeschlagen:', err);
      throw new Error(`HomeyAPI nicht verfügbar: ${err.message}`);
    }

    return this.api;
  }

  async getRawDevices() {
    await this._ensureApi();

    const devices = await this.api.devices.getDevices();
    const zones = await this.api.zones.getZones();
    const zoneMap = Object.fromEntries(Object.values(zones).map((z) => [z.id, z.name]));
    // Mirrors Homey's own zone-tree order (see lib/scanner.js), so the Settings UI
    // can group devices by zone in the same order they appear in the Homey app.
    const zoneOrderMap = scanner.buildZoneOrderMap(zones);

    return Object.values(devices)
      .map((device) => ({
        id: device.id,
        name: device.name,
        zone: device.zone ? (zoneMap[device.zone] || null) : null,
        zoneOrder: device.zone && zoneOrderMap[device.zone] !== undefined ? zoneOrderMap[device.zone] : Number.MAX_SAFE_INTEGER,
        class: device.class || null,
        available: device.available !== false,
        ownerUri: device.ownerUri || null,
        driverId: device.driverId || null,
        lastSeenAt: device.lastSeenAt || null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  getStatus() {
    return {
      config: this.config,
      lastScan: this.lastScan,
    };
  }

  // ---------------------------------------------------------------------
  // Scanning
  // ---------------------------------------------------------------------

  async runScan(source = 'manual') {
    // De-dupe concurrent scan requests (interval + flow + settings button firing close together).
    if (this._scanPromise) return this._scanPromise;

    this._scanPromise = this._runScanInternal(source).finally(() => {
      this._scanPromise = null;
    });

    return this._scanPromise;
  }

  async _runScanInternal(source) {
    await this._ensureApi();

    this.log(`Starte Scan (Quelle: ${source})`);

    const devices = await this.api.devices.getDevices();
    const zones = await this.api.zones.getZones();
    this._zoneMap = Object.fromEntries(Object.values(zones).map((z) => [z.id, z.name]));

    const result = scanner.runScan({
      devices, zones, rules: this.rules, config: this.config,
    });

    this.lastScan = { ...result, source };
    this.homey.settings.set(SETTINGS_KEY_LAST_SCAN, this.lastScan);

    await this._fireEdgeTriggers(result);

    this.log(`Scan abgeschlossen: ${result.all.length} Geräte, ${result.notReporting.length} offline, ${result.lowBattery.length} Batteriewarnungen`);

    return this.lastScan;
  }

  async _fireEdgeTriggers(result) {
    const prevNotReporting = new Set(this.flagState.notReporting || []);
    const prevLowBattery = new Set(this.flagState.lowBattery || []);

    const newlyNotReporting = result.notReporting.filter((d) => !prevNotReporting.has(d.id));
    const newlyLowBattery = result.lowBattery.filter((d) => !prevLowBattery.has(d.id));

    for (const device of newlyNotReporting) {
      await this._triggerNotReporting
        ?.trigger({
          device: device.name || '',
          zone: device.zone || '',
          last_updated: device.lastUpdated || '',
        })
        .catch((err) => this.error('Trigger device_not_reporting fehlgeschlagen:', err));
    }

    for (const device of newlyLowBattery) {
      await this._triggerBatteryLow
        ?.trigger({
          device: device.name || '',
          zone: device.zone || '',
          battery: device.battery || '',
        })
        .catch((err) => this.error('Trigger device_battery_low fehlgeschlagen:', err));
    }

    this.flagState = {
      notReporting: result.notReporting.map((d) => d.id),
      lowBattery: result.lowBattery.map((d) => d.id),
    };
    this.homey.settings.set(SETTINGS_KEY_FLAG_STATE, this.flagState);
  }

}

module.exports = DeviceWatchdogApp;
