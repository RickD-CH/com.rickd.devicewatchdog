'use strict';

const Homey = require('homey');
const { HomeyAPI } = require('homey-api');
const { DEFAULT_CONFIG, DEFAULT_RULES } = require('./lib/defaults');
const scanner = require('./lib/scanner');

const SETTINGS_KEY_CONFIG = 'config';
const SETTINGS_KEY_RULES = 'rules';
const SETTINGS_KEY_FLAG_STATE = 'flagState';
const SETTINGS_KEY_LAST_SCAN = 'lastScan';
const SETTINGS_KEY_EVENT_LOG = 'eventLog';
const SETTINGS_KEY_PROBLEM_SINCE = 'problemSince';

// Capabilities safe to re-set with their own current value as a reachability test:
// this round-trips to the hardware (so a failure means the device is truly unreachable)
// without producing a perceptible state change, unlike toggling on/off for real.
const TESTABLE_CAPABILITIES = ['onoff', 'dim'];

// Matches the capabilities lib/scanner.js itself treats as battery-relevant (percentage
// or alarm) - used to hide battery-related settings for devices that have neither.
const BATTERY_CAPABILITIES = ['measure_battery', 'alarm_battery'];

// Rolling cap for the Verlauf/log tab - keeps homey.settings from growing unbounded.
const MAX_LOG_ENTRIES = 200;

// How often to check the HomeyAPI realtime socket and resync availability, independent
// of the scan interval (which the user can disable entirely) - see _checkRealtimeConnection.
const REALTIME_HEALTHCHECK_MS = 5 * 60 * 1000;

// Caps how many device names are spelled out in a summary trigger's "devices" token /
// timeline excerpt. There's no known hard limit on Flow token length, but an unbounded
// comma list (e.g. 80 devices going offline at once) is unreadable either way - `count`
// still reflects the true total, this is purely about keeping the text usable.
const MAX_NAMES_IN_LIST = 10;

function formatNameList(names, homey) {
  if (names.length <= MAX_NAMES_IN_LIST) return names.join(', ');
  const shown = names.slice(0, MAX_NAMES_IN_LIST);
  const more = homey.__('backend.andMore', { count: names.length - MAX_NAMES_IN_LIST });
  return `${shown.join(', ')} … ${more}`;
}

function generateId() {
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// The Settings UI's <input min="..."> is a client-side hint only - it doesn't stop a
// negative/NaN value from being typed or POSTed directly. These guard the numbers that
// feed threshold math in lib/scanner.js, where e.g. a negative "hours" would make a
// device permanently show as not-reporting regardless of when it last updated.
function positiveNumberOrDefault(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function positiveNumberOrNull(value) {
  if (value === '' || value === undefined || value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Unlike positiveNumberOrDefault/positiveNumberOrNull above, 0 is a valid, meaningful
// value here ("no delay, confirm instantly") rather than "unset".
function nonNegativeNumberOrDefault(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function nonNegativeNumberOrNull(value) {
  if (value === '' || value === undefined || value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// Tri-state per-device override for a setting that also has a global default: null
// means "inherit the global config value", true/false explicitly overrides it.
function boolOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  return !!value;
}

function percentOrNull(value) {
  if (value === '' || value === undefined || value === null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(100, Math.max(0, n));
}

// One-time migration: the per-device override used to be "days until offline"
// (notReportingDays), now it's hours (notReportingHours) to match the base threshold.
function migrateRuleToHours(rule) {
  if (rule.notReportingDays == null) return rule;
  const { notReportingDays, ...rest } = rule;
  return { ...rest, notReportingHours: notReportingDays * 24 };
}

class DeviceWatchdogApp extends Homey.App {

  async onInit() {
    this.log('Device Watchdog initialized');

    this.config = { ...DEFAULT_CONFIG, ...(this.homey.settings.get(SETTINGS_KEY_CONFIG) || {}) };
    this.rules = (this.homey.settings.get(SETTINGS_KEY_RULES) || DEFAULT_RULES).map(migrateRuleToHours);
    this.homey.settings.set(SETTINGS_KEY_RULES, this.rules);
    this.flagState = this.homey.settings.get(SETTINGS_KEY_FLAG_STATE) || { notReporting: [], lowBattery: [] };
    // Since-when each device entered a problem category (widget detail view) - keyed by
    // device id, cleared once the device leaves that category again. Separate from
    // flagState (which only needs the current set, not when it started).
    this.problemSince = this.homey.settings.get(SETTINGS_KEY_PROBLEM_SINCE)
      || { notReporting: {}, lowBattery: {}, unavailable: {} };
    this.lastScan = this.homey.settings.get(SETTINGS_KEY_LAST_SCAN) || null;
    // Seeded from whatever was already on disk, so the first scan after a restart
    // doesn't write again if nothing actually changed while the app was down.
    this._lastPersistedScanSignature = this._scanSignature(this.lastScan);
    this.eventLog = this.homey.settings.get(SETTINGS_KEY_EVENT_LOG) || [];

    this._zoneMap = {};
    this._availabilityMap = new Map();
    this._intervalTimer = null;
    this._scanPromise = null;
    this._unavailableBatch = new Set();
    this._unavailableBatchTimer = null;
    this._pendingUnavailableTimers = new Map();
    this._confirmedUnavailable = new Set();

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

    // Independent safety net for the realtime socket: runs regardless of whether the
    // interval scan is enabled, so "unavailable" tracking stays correct even with
    // automatic scanning turned off. See _checkRealtimeConnection for what it catches.
    this.homey.setInterval(() => {
      this._checkRealtimeConnection().catch((err) => this.error('Realtime-Healthcheck fehlgeschlagen:', err));
    }, REALTIME_HEALTHCHECK_MS);
  }

  // The virtual Watchdog device itself is just another device as far as HomeyAPI is
  // concerned - excluded everywhere devices are gathered so it never monitors itself
  // (its own capabilities are driven purely by _updateWatchdogDevice, not real sensor
  // data, so "not reporting"/battery checks on it would be meaningless noise).
  _isOwnDevice(device) {
    return !!device && device.ownerUri === `homey:app:${this.homey.manifest.id}`;
  }

  // The homey-api socket does auto-reconnect at the transport level, but that's opaque
  // to us and never replays events missed while disconnected. This periodically (a)
  // makes sure we're actually connected, reconnecting explicitly if not, and (b) always
  // re-syncs availability afterwards so a silently-missed transition still gets caught -
  // both cheaper and more reliable than trying to hook into internal socket events.
  async _checkRealtimeConnection() {
    if (!this.api) return;

    if (!this.api.devices.isConnected()) {
      this.log('Realtime-Verbindung getrennt, verbinde neu...');
      await this.api.devices.connect();
    }

    await this._reconcileAvailability();
  }

  // Re-checks every device's availability against our cached map and fires the same
  // edge-trigger logic as a live realtime event for anything that changed while we
  // weren't watching (missed socket event, or the socket having been down).
  async _reconcileAvailability() {
    const devices = await this.api.devices.getDevices();
    for (const device of Object.values(devices)) {
      if (this._isOwnDevice(device)) continue;
      this._handleDeviceUpdate(device);
    }
  }

  // ---------------------------------------------------------------------
  // Flow cards
  // ---------------------------------------------------------------------

  _registerFlowCards() {
    this.homey.flow.getActionCard('run_scan').registerRunListener(async () => {
      await this.runScan('flow');
      return true;
    });

    this._triggerNotReporting = this.homey.flow.getTriggerCard('device_not_reporting')
      .registerRunListener(this._deviceArgMatches)
      .registerArgumentAutocompleteListener('target_device', this._deviceAutocomplete.bind(this));
    this._triggerBatteryLow = this.homey.flow.getTriggerCard('device_battery_low')
      .registerRunListener(this._deviceArgMatches)
      .registerArgumentAutocompleteListener('target_device', this._deviceAutocomplete.bind(this));
    this._triggerUnavailable = this.homey.flow.getTriggerCard('device_unavailable')
      .registerRunListener(this._deviceArgMatches)
      .registerArgumentAutocompleteListener('target_device', this._deviceAutocomplete.bind(this));

    // Summary triggers: fire once per batch (scan, or realtime debounce window) with
    // every newly-affected device bundled into count/devices tokens, so a Flow doesn't
    // fire N times in a row when N devices break at once.
    this._triggerNotReportingSummary = this.homey.flow.getTriggerCard('devices_not_reporting_summary');
    this._triggerBatteryLowSummary = this.homey.flow.getTriggerCard('devices_low_battery_summary');
    this._triggerUnavailableSummary = this.homey.flow.getTriggerCard('devices_unavailable_summary');

    this.homey.flow.getConditionCard('device_is_unavailable')
      .registerRunListener(async (args) => this._confirmedUnavailable.has(args.device.id)
        && this._isMonitored(args.device.id))
      .registerArgumentAutocompleteListener('device', this._deviceAutocomplete.bind(this));

    this.homey.flow.getConditionCard('device_is_not_reporting')
      .registerRunListener(async (args) => (this.lastScan?.notReporting || []).includes(args.device.id))
      .registerArgumentAutocompleteListener('device', this._deviceAutocomplete.bind(this));

    this.homey.flow.getConditionCard('device_has_low_battery')
      .registerRunListener(async (args) => (this.lastScan?.lowBattery || []).includes(args.device.id))
      .registerArgumentAutocompleteListener('device', this._deviceAutocomplete.bind(this));
  }

  // Required device-picker arg shared by the per-device triggers: fires only for the
  // selected device. Broadcasting to any device is handled by the separate summary
  // triggers (devices_*_summary) instead, so there's no ambiguous "leave it empty" mode.
  async _deviceArgMatches(args, state) {
    return args.target_device.id === state.deviceId;
  }

  async _deviceAutocomplete(query) {
    await this._ensureApi();
    const devices = await this.api.devices.getDevices();
    const q = (query || '').toLowerCase();

    return Object.values(devices)
      .filter((d) => !this._isOwnDevice(d) && (!q || d.name.toLowerCase().includes(q)))
      .map((d) => ({ id: d.id, name: d.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  _notifyTimeline(excerpt) {
    if (!this.config.timelineNotifications) return;
    this.homey.notifications.createNotification({ excerpt })
      .catch((err) => this.error('Timeline-Meldung fehlgeschlagen:', err));
  }

  // Verlauf-Tab: records the same edge-triggered events that already fire the Flow
  // triggers / timeline notice, so problems can be traced back after the fact.
  _recordEvent(type, { device, zone, detail } = {}) {
    this.eventLog.unshift({
      ts: Date.now(), type, device: device || '', zone: zone || '', detail: detail || null,
    });
    if (this.eventLog.length > MAX_LOG_ENTRIES) this.eventLog.length = MAX_LOG_ENTRIES;
    this.homey.settings.set(SETTINGS_KEY_EVENT_LOG, this.eventLog);
  }

  getLog() {
    return this.eventLog;
  }

  clearLog() {
    this.eventLog = [];
    this.homey.settings.set(SETTINGS_KEY_EVENT_LOG, this.eventLog);
    return this.eventLog;
  }

  // ---------------------------------------------------------------------
  // Realtime availability ("device_unavailable" trigger, delayed by the
  // configurable grace period - see _getUnavailableDelaySeconds)
  // ---------------------------------------------------------------------

  async _primeAvailabilityMap() {
    const devices = await this.api.devices.getDevices();
    const zones = await this.api.zones.getZones();
    this._zoneMap = Object.fromEntries(Object.values(zones).map((z) => [z.id, z.name]));

    this._availabilityMap.clear();
    this._confirmedUnavailable.clear();
    for (const device of Object.values(devices)) {
      if (this._isOwnDevice(device)) continue;
      const isAvailable = device.available !== false;
      this._availabilityMap.set(device.id, isAvailable);
      if (!isAvailable) {
        // Already down at startup - route through the same grace period a live
        // transition would get, so a Homey/app restart doesn't instantly count devices
        // that are simply still reconnecting. Confirmation is silent either way (no
        // trigger/log/timeline) since this isn't a transition we actually witnessed.
        const delaySeconds = this._getUnavailableDelaySeconds(device.id);
        if (delaySeconds > 0) {
          this._scheduleUnavailableConfirmation(device, delaySeconds, true);
        } else {
          this._confirmUnavailable(device, true);
        }
      }
    }

    // Prune "since" bookkeeping for anything that recovered while we weren't watching
    // (API was down, so _handleDeviceUpdate's own recovery cleanup never ran for it) -
    // otherwise the stale timestamp from that old outage would resurface the next time
    // this same device goes unavailable again (see _confirmUnavailable's "already
    // tracked, don't overwrite" guard).
    for (const id of Object.keys(this.problemSince.unavailable)) {
      if (!this._confirmedUnavailable.has(id) && !this._pendingUnavailableTimers.has(id)) {
        delete this.problemSince.unavailable[id];
      }
    }
    this._persistProblemSince();
  }

  async _connectRealtime() {
    await this.api.devices.connect();
    this.api.devices.on('device.update', (device) => this._handleDeviceUpdate(device));
  }

  _handleDeviceUpdate(device) {
    if (!device || !device.id || this._isOwnDevice(device)) return;

    const wasAvailable = this._availabilityMap.get(device.id);
    const isAvailable = device.available !== false;
    this._availabilityMap.set(device.id, isAvailable);

    if (wasAvailable === true && isAvailable === false) {
      const delaySeconds = this._getUnavailableDelaySeconds(device.id);
      if (delaySeconds > 0) {
        this._scheduleUnavailableConfirmation(device, delaySeconds);
      } else {
        this._confirmUnavailable(device);
      }
    }

    if (isAvailable === true) {
      // Recovery is never delayed - if it came back before the grace period elapsed,
      // this cancels the pending confirmation and nothing ever fired for it. If it was
      // already confirmed, clear that immediately (good news shouldn't wait either).
      this._cancelPendingUnavailableConfirmation(device.id);
      if (this._confirmedUnavailable.delete(device.id)) {
        delete this.problemSince.unavailable[device.id];
        this._persistProblemSince();
        this._updateWatchdogDevice({ unavailableCount: this._countUnavailable() })
          .catch((err) => this.error('Watchdog-Gerät-Update fehlgeschlagen:', err));
      }
    }
  }

  _getUnavailableDelaySeconds(deviceId) {
    const { rule } = scanner.findRule({ id: deviceId }, this.rules);
    const override = rule?.unavailableDelaySeconds;
    return (override != null ? override : this.config.unavailableDelaySeconds) || 0;
  }

  _scheduleUnavailableConfirmation(device, delaySeconds, silent) {
    this._cancelPendingUnavailableConfirmation(device.id);
    const timer = this.homey.setTimeout(() => {
      this._pendingUnavailableTimers.delete(device.id);
      // Re-check current state - only proceed if it's still down after the grace period.
      if (this._availabilityMap.get(device.id) === false) this._confirmUnavailable(device, silent);
    }, delaySeconds * 1000);
    this._pendingUnavailableTimers.set(device.id, timer);
  }

  _cancelPendingUnavailableConfirmation(deviceId) {
    const timer = this._pendingUnavailableTimers.get(deviceId);
    if (timer) {
      this.homey.clearTimeout(timer);
      this._pendingUnavailableTimers.delete(deviceId);
    }
  }

  // Everything a confirmed (grace period elapsed, or delay=0) "unavailable" produces:
  // excludeAll ("monitored" off) means silent everywhere, full stop. Short of that, the
  // per-device trigger still always fires (opt-in - only noisy if the user builds a Flow
  // around this specific device); the summary/Timeline/log/count are the automatic,
  // passive outputs a chronically flaky device would otherwise spam repeatedly, so those
  // additionally respect the narrower "Ignore unavailable" per-device toggle too.
  // `silent` skips the trigger/log/timeline/summary entirely - used when priming at
  // startup confirms a device that was already down before the grace period even
  // started, so app restarts don't re-notify for an already-known, ongoing problem.
  _confirmUnavailable(device, silent) {
    this._confirmedUnavailable.add(device.id);

    if (!(device.id in this.problemSince.unavailable)) {
      // Priming an already-down device at startup: lastSeenAt is the last time it was
      // known good, a better "since" than the moment we merely noticed it on restart.
      this.problemSince.unavailable[device.id] = (silent && device.lastSeenAt)
        ? new Date(device.lastSeenAt).getTime()
        : Date.now();
      this._persistProblemSince();
    }

    if (!silent) {
      const zoneName = device.zone ? (this._zoneMap[device.zone] || '') : '';

      if (this._isMonitored(device.id)) {
        this._triggerUnavailable
          ?.trigger({ device: device.name || '', zone: zoneName || '' }, { deviceId: device.id })
          .catch((err) => this.error('Trigger device_unavailable fehlgeschlagen:', err));
      }

      if (!this._isExcludedFromUnavailable(device.id)) {
        this._recordEvent('unavailable', { device: device.name, zone: zoneName, detail: device.lastSeenAt || null });
        this._queueUnavailableSummary(device.name || '');
      }
    }

    this._updateWatchdogDevice({ unavailableCount: this._countUnavailable() })
      .catch((err) => this.error('Watchdog-Gerät-Update fehlgeschlagen:', err));
  }

  _countUnavailable() {
    let count = 0;
    for (const deviceId of this._confirmedUnavailable) {
      if (!this._isExcludedFromUnavailable(deviceId)) count += 1;
    }
    return count;
  }

  _persistProblemSince() {
    this.homey.settings.set(SETTINGS_KEY_PROBLEM_SINCE, this.problemSince);
  }

  // excludeAll ("monitored" off) - the one condition that should silence a device
  // absolutely everywhere, including its own opt-in per-device trigger/condition. Used
  // on its own (not via _isExcludedFromUnavailable) wherever explicit per-device Flow
  // usage should still work under the narrower "Ignore unavailable" toggle.
  _isMonitored(deviceId) {
    const { rule } = scanner.findRule({ id: deviceId }, this.rules);
    return !rule?.excludeAll;
  }

  // A device with monitoring off entirely (excludeAll) should stay silent everywhere,
  // not just for battery/reporting - a device the user turned monitoring off for is not
  // supposed to trip the watchdog's "unavailable" count either. excludeFromUnavailable
  // is the narrower opt-in for "keep monitoring battery/reporting, just not unavailable"
  // - used for the passive/aggregate outputs (count, log, summary, widget), not for
  // explicit per-device Flow usage (see _isMonitored).
  _isExcludedFromUnavailable(deviceId) {
    const { rule } = scanner.findRule({ id: deviceId }, this.rules);
    return !!rule?.excludeAll || !!rule?.excludeFromUnavailable;
  }

  // Pushes counts to the virtual "Watchdog status" device (drivers/watchdog), if the
  // user has paired one - so they show up in Homey Insights/dashboards and are usable
  // in Flows without our own cards. A no-op (not an error) if none has been added yet.
  async _updateWatchdogDevice(counts) {
    let devices;
    try {
      devices = this.homey.drivers.getDriver('watchdog').getDevices();
    } catch (err) {
      return; // driver not ready yet (e.g. called during very early onInit)
    }

    await Promise.all(devices.map((device) => device.updateCounts(counts)))
      .catch((err) => this.error('Watchdog-Gerät-Update fehlgeschlagen:', err));
  }

  // Bundles devices that go unavailable within a few seconds of each other (e.g. a
  // mesh network hiccup) into a single summary trigger + timeline entry, instead of
  // firing/notifying once per device.
  _queueUnavailableSummary(name) {
    this._unavailableBatch.add(name);
    if (this._unavailableBatchTimer) return;

    this._unavailableBatchTimer = this.homey.setTimeout(() => {
      const names = Array.from(this._unavailableBatch);
      this._unavailableBatch.clear();
      this._unavailableBatchTimer = null;

      const devicesList = formatNameList(names, this.homey);

      this._triggerUnavailableSummary
        ?.trigger({ count: names.length, devices: devicesList })
        .catch((err) => this.error('Trigger devices_unavailable_summary fehlgeschlagen:', err));

      this._notifyTimeline(this.homey.__('backend.timelineUnavailable', { count: names.length, devices: devicesList }));
    }, 3000);
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

  // Comparable "did anything actually change" key for a persisted scan snapshot -
  // deliberately excludes generatedAt/source, which differ on every single scan
  // regardless of whether the actual results did.
  _scanSignature(scan) {
    if (!scan) return null;
    return JSON.stringify({
      all: scan.all, notReporting: scan.notReporting, lowBattery: scan.lowBattery,
    });
  }

  // Resets global config and all per-device rules back to defaults - e.g. to get back
  // to a clean slate while testing. Deliberately leaves the log/last-scan history alone,
  // those have their own dedicated "clear" controls with different semantics.
  async resetSettings() {
    return this.saveConfig({ config: { ...DEFAULT_CONFIG }, rules: [] });
  }

  async saveConfig({ config, rules } = {}) {
    if (config && typeof config === 'object') {
      this.config = {
        ...DEFAULT_CONFIG,
        ...config,
        notReportingThresholdHours: positiveNumberOrDefault(
          config.notReportingThresholdHours, DEFAULT_CONFIG.notReportingThresholdHours,
        ),
        batteryThresholdPercent: percentOrNull(config.batteryThresholdPercent) ?? DEFAULT_CONFIG.batteryThresholdPercent,
        scanIntervalMinutes: positiveNumberOrDefault(config.scanIntervalMinutes, DEFAULT_CONFIG.scanIntervalMinutes),
        unavailableDelaySeconds: nonNegativeNumberOrDefault(
          config.unavailableDelaySeconds, DEFAULT_CONFIG.unavailableDelaySeconds,
        ),
      };
      this.homey.settings.set(SETTINGS_KEY_CONFIG, this.config);
    }

    if (Array.isArray(rules)) {
      this.rules = rules.map((rule) => ({
        id: rule.id || generateId(),
        matchType: rule.matchType,
        matchValue: rule.matchValue,
        label: rule.label || '',
        notReportingHours: positiveNumberOrNull(rule.notReportingHours),
        batteryThreshold: percentOrNull(rule.batteryThreshold),
        excludeBattery: !!rule.excludeBattery,
        onlyCheckBattery: !!rule.onlyCheckBattery,
        excludeAll: !!rule.excludeAll,
        excludeFromUnavailable: !!rule.excludeFromUnavailable,
        unavailableDelaySeconds: nonNegativeNumberOrNull(rule.unavailableDelaySeconds),
        includeLastSeenForReporting: boolOrNull(rule.includeLastSeenForReporting),
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
    // Resolve real app display names (e.g. "Z-Wave") for the "Verwaltet von" info line,
    // instead of showing the raw app id. Best-effort: if this fails (e.g. missing scope),
    // devices simply fall back to their raw ownerUri app id further down the chain.
    const appNameMap = await this._getAppNameMap();

    return Object.values(devices)
      .filter((device) => !this._isOwnDevice(device))
      .map((device) => {
        const ownerAppId = device.ownerUri ? device.ownerUri.replace(/^homey:app:/, '') : null;
        return {
          id: device.id,
          name: device.name,
          zone: device.zone ? (zoneMap[device.zone] || null) : null,
          zoneOrder: device.zone && zoneOrderMap[device.zone] !== undefined ? zoneOrderMap[device.zone] : Number.MAX_SAFE_INTEGER,
          class: device.class || null,
          available: device.available !== false,
          testCapability: TESTABLE_CAPABILITIES.find((id) => (device.capabilities || []).includes(id)) || null,
          hasBattery: BATTERY_CAPABILITIES.some((id) => (device.capabilities || []).includes(id)),
          ownerUri: device.ownerUri || null,
          ownerAppName: ownerAppId ? (appNameMap[ownerAppId] || null) : null,
          driverId: device.driverId || null,
          lastSeenAt: device.lastSeenAt || null,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async _getAppNameMap() {
    try {
      const apps = await this.api.apps.getApps();
      const map = {};
      for (const [key, app] of Object.entries(apps || {})) {
        const name = typeof app.name === 'string' ? app.name : (app.name && (app.name.en || Object.values(app.name)[0]));
        if (name) {
          map[key] = name;
          if (app.id) map[app.id] = name;
        }
      }
      return map;
    } catch (err) {
      this.error('Konnte App-Namen nicht laden:', err);
      return {};
    }
  }

  async testDevice(deviceId) {
    await this._ensureApi();

    const device = await this.api.devices.getDevice({ id: deviceId });
    if (!device) throw new Error(this.homey.__('backend.deviceNotFound'));

    const zoneName = device.zone ? (this._zoneMap[device.zone] || '') : '';

    try {
      const capabilityId = TESTABLE_CAPABILITIES.find((id) => (device.capabilities || []).includes(id));
      if (!capabilityId) throw new Error(this.homey.__('backend.noTestableCapability'));

      const currentValue = device.capabilitiesObj?.[capabilityId]?.value;
      if (currentValue === undefined || currentValue === null) throw new Error(this.homey.__('backend.noCurrentValue'));

      await device.setCapabilityValue({ capabilityId, value: currentValue });

      this._recordEvent('testSuccess', { device: device.name, zone: zoneName });
      return { ok: true, capabilityId, value: currentValue };
    } catch (err) {
      this._recordEvent('testFailure', { device: device.name, zone: zoneName, detail: err.message });
      throw err;
    }
  }

  getStatus() {
    return {
      config: this.config,
      lastScan: this.lastScan,
    };
  }

  // Widget-facing summary: same counts/alarm as the Watchdog status device tile, plus
  // (unlike that capability-only tile) which devices are actually affected, since when,
  // and a category-specific detail.
  async getWidgetSummary() {
    const rawDevices = await this.getRawDevices();
    const rawById = Object.fromEntries(rawDevices.map((d) => [d.id, d]));
    const scanById = Object.fromEntries((this.lastScan?.all || []).map((d) => [d.id, d]));

    // Always one entry per flagged id, even if the device vanished from the live list
    // between the scan/confirmation and now (renamed/removed edge case) - silently
    // dropping it here would leave the detail list short of what the count promises.
    const buildEntries = (ids, category, extra) => ids
      .map((id) => {
        const raw = rawById[id] || null;
        return {
          id,
          name: raw ? raw.name : id,
          zone: raw ? raw.zone : null,
          since: this.problemSince[category][id] || null,
          ...extra(raw, id),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    const notReportingIds = this.lastScan?.notReporting || [];
    const lowBatteryIds = this.lastScan?.lowBattery || [];
    const unavailableIds = Array.from(this._confirmedUnavailable)
      .filter((id) => !this._isExcludedFromUnavailable(id));

    // scanById is keyed from the same scan notReportingIds/lowBatteryIds came from, so
    // it's looked up by the entry's own id - independent of whether the raw live device
    // lookup above succeeded.
    const notReporting = buildEntries(notReportingIds, 'notReporting', (raw, id) => ({
      lastUpdated: scanById[id]?.lastUpdated || null,
    }));
    const lowBattery = buildEntries(lowBatteryIds, 'lowBattery', (raw, id) => ({
      battery: scanById[id]?.battery || null,
      batteryValue: scanById[id]?.batteryValue ?? null,
    }));
    const unavailable = buildEntries(unavailableIds, 'unavailable', (raw) => ({
      lastSeenAt: raw ? raw.lastSeenAt || null : null,
    }));

    const counts = {
      notReporting: notReportingIds.length,
      lowBattery: lowBatteryIds.length,
      unavailable: unavailableIds.length,
    };

    // Same formula as WatchdogDevice.updateCounts (drivers/watchdog/device.js), so the
    // widget's alarm state always matches the paired device tile's.
    const alarm = (this.config.alarmIncludesNotReporting !== false && counts.notReporting > 0)
      || (this.config.alarmIncludesUnavailable !== false && counts.unavailable > 0)
      || (this.config.alarmIncludesLowBattery !== false && counts.lowBattery > 0);

    return {
      lastScanAt: this.lastScan?.generatedAt || null,
      counts,
      alarm,
      notReporting,
      lowBattery,
      unavailable,
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

    // $cache: false - once realtime-connected, getDevices() normally just returns the
    // in-memory cache and relies entirely on realtime events to keep it fresh. A missed
    // event (seen with a Bluetooth-relayed device) then leaves it stale forever, and a
    // "scan" would silently re-check the same stale snapshot. A scan should always see
    // the real current state, so this bypasses that cache explicitly.
    const rawDevices = await this.api.devices.getDevices({ $cache: false });
    const zones = await this.api.zones.getZones();
    this._zoneMap = Object.fromEntries(Object.values(zones).map((z) => [z.id, z.name]));

    // Extra safety net on top of _checkRealtimeConnection: catches a missed transition
    // immediately on every scan instead of waiting for the next healthcheck tick.
    const devices = {};
    for (const [id, device] of Object.entries(rawDevices)) {
      if (this._isOwnDevice(device)) continue;
      devices[id] = device;
      this._handleDeviceUpdate(device);
    }

    const result = scanner.runScan({
      devices, zones, rules: this.rules, config: this.config,
    });

    // Persisted/exposed scan snapshot is intentionally much leaner than `result`:
    // the Settings UI and condition cards only ever read id/status/battery/lastUpdated
    // per device and device ids for the not-reporting/low-battery lists - name, zone,
    // class, availability, and the (fully derivable, unused) `excluded` list would just
    // be duplicated write volume on every scan for no benefit. `result` itself stays
    // full for _fireEdgeTriggers below, which does need those fields.
    this.lastScan = {
      generatedAt: result.generatedAt,
      source,
      all: result.all.map((d) => ({
        id: d.id, status: d.status, battery: d.battery, lastUpdated: d.lastUpdated,
      })),
      notReporting: result.notReporting.map((d) => d.id),
      lowBattery: result.lowBattery.map((d) => d.id),
    };
    // Only actually write to settings storage when the substantive result changed -
    // the in-memory copy above is always fresh regardless (live consumers, e.g. the
    // Settings UI's "last scan" timestamp, are unaffected), this only skips redundant
    // disk writes when a scan finds exactly the same thing as the previous one.
    const scanSignature = this._scanSignature(this.lastScan);
    if (scanSignature !== this._lastPersistedScanSignature) {
      this._lastPersistedScanSignature = scanSignature;
      this.homey.settings.set(SETTINGS_KEY_LAST_SCAN, this.lastScan);
    }

    await this._updateWatchdogDevice({
      notReportingCount: result.notReporting.length,
      lowBatteryCount: result.lowBattery.length,
    });

    await this._fireEdgeTriggers(result);

    this.log(`Scan abgeschlossen: ${result.all.length} Geräte, ${result.notReporting.length} offline, ${result.lowBattery.length} Batteriewarnungen`);

    return this.lastScan;
  }

  async _fireEdgeTriggers(result) {
    const prevNotReporting = new Set(this.flagState.notReporting || []);
    const prevLowBattery = new Set(this.flagState.lowBattery || []);
    const nowNotReporting = new Set(result.notReporting.map((d) => d.id));
    const nowLowBattery = new Set(result.lowBattery.map((d) => d.id));

    const newlyNotReporting = result.notReporting.filter((d) => !prevNotReporting.has(d.id));
    const newlyLowBattery = result.lowBattery.filter((d) => !prevLowBattery.has(d.id));

    // "Since" bookkeeping for the widget detail view - set when a device newly enters a
    // category, cleared when it leaves again (independent of the trigger/log logic below).
    for (const id of prevNotReporting) {
      if (!nowNotReporting.has(id)) delete this.problemSince.notReporting[id];
    }
    for (const id of prevLowBattery) {
      if (!nowLowBattery.has(id)) delete this.problemSince.lowBattery[id];
    }
    for (const device of newlyNotReporting) this.problemSince.notReporting[device.id] = Date.now();
    for (const device of newlyLowBattery) this.problemSince.lowBattery[device.id] = Date.now();

    for (const device of newlyNotReporting) {
      await this._triggerNotReporting
        ?.trigger({
          device: device.name || '',
          zone: device.zone || '',
          last_updated: device.lastUpdated || '',
        }, { deviceId: device.id })
        .catch((err) => this.error('Trigger device_not_reporting fehlgeschlagen:', err));

      this._recordEvent('notReporting', { device: device.name, zone: device.zone, detail: device.lastUpdated });
    }

    for (const device of newlyLowBattery) {
      await this._triggerBatteryLow
        ?.trigger({
          device: device.name || '',
          zone: device.zone || '',
          battery: device.battery || '',
        }, { deviceId: device.id })
        .catch((err) => this.error('Trigger device_battery_low fehlgeschlagen:', err));

      this._recordEvent('lowBattery', { device: device.name, zone: device.zone, detail: device.battery });
    }

    if (newlyNotReporting.length) {
      const devicesList = formatNameList(newlyNotReporting.map((d) => d.name), this.homey);

      await this._triggerNotReportingSummary
        ?.trigger({ count: newlyNotReporting.length, devices: devicesList })
        .catch((err) => this.error('Trigger devices_not_reporting_summary fehlgeschlagen:', err));

      this._notifyTimeline(this.homey.__('backend.timelineNotReporting', { count: newlyNotReporting.length, devices: devicesList }));
    }

    if (newlyLowBattery.length) {
      const devicesList = formatNameList(newlyLowBattery.map((d) => d.name), this.homey);

      await this._triggerBatteryLowSummary
        ?.trigger({ count: newlyLowBattery.length, devices: devicesList })
        .catch((err) => this.error('Trigger devices_low_battery_summary fehlgeschlagen:', err));

      this._notifyTimeline(this.homey.__('backend.timelineLowBattery', { count: newlyLowBattery.length, devices: devicesList }));
    }

    this.flagState = {
      notReporting: result.notReporting.map((d) => d.id),
      lowBattery: result.lowBattery.map((d) => d.id),
    };
    this.homey.settings.set(SETTINGS_KEY_FLAG_STATE, this.flagState);
    this._persistProblemSince();
  }

}

module.exports = DeviceWatchdogApp;
