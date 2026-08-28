'use strict';

/**
 * Core scanning logic, ported from the original Homey Script
 * "Device Monitor & Battery Checker v2.4".
 *
 * Kept free of any Homey.* / HomeyAPI calls on purpose so it can be
 * unit tested with plain objects and reused from app.js.
 */

function safeRegExp(pattern, flags = 'i') {
  if (!pattern) return null;
  try {
    return new RegExp(pattern, flags);
  } catch (err) {
    return null;
  }
}

function formatDate(date) {
  if (!date || Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/**
 * Builds a map of zoneId -> sortIndex that mirrors the order zones are shown
 * in Homey's own device list (a pre-order walk of the zone tree, siblings
 * sorted by their `order` field like Homey does, falling back to name).
 * Devices in the same zone all get the same index, which is exactly what's
 * needed to sort zone groups in the Settings UI the way Homey itself does.
 * @param {object} zones - raw zones map/array as returned by the Homey API (each with id, name, parent, order)
 * @returns {Object<string, number>}
 */
function buildZoneOrderMap(zones) {
  const zoneList = Object.values(zones || {});
  const byParent = {};

  for (const zone of zoneList) {
    const parentKey = zone.parent || '__root__';
    if (!byParent[parentKey]) byParent[parentKey] = [];
    byParent[parentKey].push(zone);
  }

  for (const siblings of Object.values(byParent)) {
    siblings.sort((a, b) => {
      const orderA = typeof a.order === 'number' ? a.order : 0;
      const orderB = typeof b.order === 'number' ? b.order : 0;
      if (orderA !== orderB) return orderA - orderB;
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
  }

  const orderMap = {};
  let counter = 0;

  function visit(parentKey) {
    const siblings = byParent[parentKey] || [];
    for (const zone of siblings) {
      orderMap[zone.id] = counter;
      counter += 1;
      visit(zone.id);
    }
  }

  visit('__root__');

  return orderMap;
}

/**
 * Finds the first matching rule for a device, using the same precedence
 * as the original script: exact ID > exact name > first matching pattern.
 * @returns {{ rule: object|null, ruleApplied: 'ID'|'NM'|'PT'|'--' }}
 */
function findRule(device, rules) {
  const byId = rules.find((r) => r.matchType === 'id' && r.matchValue === device.id);
  if (byId) return { rule: byId, ruleApplied: 'ID' };

  const byName = rules.find((r) => r.matchType === 'name' && r.matchValue === device.name);
  if (byName) return { rule: byName, ruleApplied: 'NM' };

  const patternRules = rules.filter((r) => r.matchType === 'pattern');
  for (const rule of patternRules) {
    const re = safeRegExp(rule.matchValue);
    if (re && re.test(device.name || '')) {
      return { rule, ruleApplied: 'PT' };
    }
  }

  return { rule: null, ruleApplied: '--' };
}

/**
 * Precomputes id/name -> rule maps once, so a caller doing this per-device (once per
 * device on every scan, or once per realtime device-update event) doesn't re-scan the
 * whole rules array from scratch every single time - on an installation with hundreds
 * of devices and rules, findRule's linear .find()/.filter() adds up fast when called
 * that often. Pattern rules can't be indexed by exact value (they match via regex), so
 * they stay a plain list, checked in the same order as before. "First rule of a type
 * wins" (matching Array#find's behavior) is preserved by only ever setting a key once.
 * @returns {{ byId: Map, byName: Map, patterns: object[] }}
 */
function buildRuleIndex(rules) {
  const byId = new Map();
  const byName = new Map();
  const patterns = [];

  for (const rule of rules) {
    if (rule.matchType === 'id') {
      if (!byId.has(rule.matchValue)) byId.set(rule.matchValue, rule);
    } else if (rule.matchType === 'name') {
      if (!byName.has(rule.matchValue)) byName.set(rule.matchValue, rule);
    } else if (rule.matchType === 'pattern') {
      patterns.push(rule);
    }
  }

  return { byId, byName, patterns };
}

/**
 * Same precedence/result shape as findRule, but against a prebuilt buildRuleIndex()
 * instead of a raw rules array - O(1) for the common ID/name cases instead of O(rules).
 */
function findRuleIndexed(device, index) {
  const byId = index.byId.get(device.id);
  if (byId) return { rule: byId, ruleApplied: 'ID' };

  const byName = index.byName.get(device.name);
  if (byName) return { rule: byName, ruleApplied: 'NM' };

  for (const rule of index.patterns) {
    const re = safeRegExp(rule.matchValue);
    if (re && re.test(device.name || '')) {
      return { rule, ruleApplied: 'PT' };
    }
  }

  return { rule: null, ruleApplied: '--' };
}

/**
 * Whether a rule's seasonal pause is currently active. Paused through the end of
 * the selected calendar day (not the exact instant midnight starts) - picking
 * "today" should keep a device paused for the rest of today, not expire it the
 * instant it's set. Self-resolving: this is re-evaluated fresh on every call,
 * no separate scheduler needed to "wake" a device back up once the date passes.
 */
function isRulePaused(rule) {
  if (!rule || !rule.pausedUntil) return false;
  const end = new Date(rule.pausedUntil);
  if (Number.isNaN(end.getTime())) return false;
  end.setHours(23, 59, 59, 999);
  return Date.now() <= end.getTime();
}

/**
 * Capability bases that never tell us anything useful about "is this device still reporting":
 * - `button` is momentary/stateless and never carries a `lastUpdated` (Homey only fires a Flow
 *   trigger for it, confirmed on the community thread for virtual "button" devices from
 *   com.arjankranenburg.virtual).
 * - `measure_battery` / `alarm_battery` only update when the device happens to wake up and
 *   report - on button-driven devices (remotes, Hue Tap Dial, ...) that's exactly the same rare
 *   "only on press" cadence as the button itself, so a device untouched for months looks
 *   "not reporting" even though it's perfectly reachable (reported on the community thread for
 *   a Hue Tap Dial: `lastUpdated` from February, `lastSeenAt` from today). Battery level itself
 *   is still monitored separately via the low-battery check below - this only controls the
 *   staleness/"not reporting" check.
 */
const NON_INFORMATIVE_STALENESS_CAP_BASES = new Set(['button', 'measure_battery', 'alarm_battery']);

/**
 * Whether a device can meaningfully be checked for staleness at all. A device whose only
 * capabilities are momentary/stateless or battery-only never carries a meaningful `lastUpdated`
 * on its own - see NON_INFORMATIVE_STALENESS_CAP_BASES above. Running the "not reporting" check
 * on such a device would flag it forever with nothing the user could do about it.
 *
 * A device that DOES have a real capability (measure_*, onoff, a sensor, ...) but has simply
 * never sent data is still checkable here - it stays flagged exactly as before. The
 * discriminator is the capability shape, not whether a timestamp happens to be present.
 * Falls back to the keys of capabilitiesObj when `capabilities` isn't populated (defensive -
 * the real HomeyAPI always sets it, plain-object test fixtures often don't).
 */
function canCheckStaleness(device) {
  const caps = Array.isArray(device.capabilities) && device.capabilities.length
    ? device.capabilities
    : Object.keys(device.capabilitiesObj || {});
  return caps.some((cap) => !NON_INFORMATIVE_STALENESS_CAP_BASES.has(String(cap).split('.')[0]));
}

/**
 * Computes reporting + battery status for a single device given its matched rule.
 */
function computeDeviceStatus(device, rule, config) {
  const custom = rule || {};

  let maxLastUpdatedTime = null;
  let isReporting = true;

  if (!custom.onlyCheckBattery && canCheckStaleness(device)) {
    for (const cap of Object.values(device.capabilitiesObj || {})) {
      if (!cap || !cap.lastUpdated) continue;
      const time = new Date(cap.lastUpdated).getTime();
      if (Number.isFinite(time) && time > (maxLastUpdatedTime || 0)) maxLastUpdatedTime = time;
    }

    const includeLastSeen = custom.includeLastSeenForReporting !== null && custom.includeLastSeenForReporting !== undefined
      ? custom.includeLastSeenForReporting
      : config.includeLastSeenForReporting;
    if (includeLastSeen && device.lastSeenAt) {
      const seenTime = new Date(device.lastSeenAt).getTime();
      if (Number.isFinite(seenTime) && seenTime > (maxLastUpdatedTime || 0)) maxLastUpdatedTime = seenTime;
    }

    const thresholdHrs = custom.notReportingHours
      ? custom.notReportingHours
      : config.notReportingThresholdHours;

    isReporting = (Date.now() - (maxLastUpdatedTime || 0)) < (thresholdHrs * 3600000);
  }

  let batteryStatus = 'N/A';
  let batteryValue = null;
  let isLowBattery = false;

  if (custom.excludeBattery) {
    batteryStatus = 'EXCL';
  } else {
    const measuredPct = device.capabilitiesObj?.measure_battery?.value;
    const alarmBattery = device.capabilitiesObj?.alarm_battery?.value;
    const threshold = custom.batteryThreshold !== undefined && custom.batteryThreshold !== null
      ? custom.batteryThreshold
      : config.batteryThresholdPercent;

    if (typeof measuredPct === 'number' && !Number.isNaN(measuredPct)) {
      batteryValue = Math.round(measuredPct);
      batteryStatus = `${batteryValue}%`;
      if (measuredPct <= threshold) isLowBattery = true;
    } else if (alarmBattery) {
      batteryStatus = 'ALARM';
      isLowBattery = true;
    } else if (Array.isArray(device.capabilities) && device.capabilities.includes('measure_battery')) {
      batteryStatus = 'OK';
    }
  }

  return {
    maxLastUpdatedTime,
    isReporting,
    batteryStatus,
    batteryValue,
    isLowBattery,
  };
}

/**
 * Runs a full scan over the given devices/zones using the given rules/config.
 * @returns {{ all: object[], notReporting: object[], lowBattery: object[], excluded: object[], generatedAt: string }}
 */
function runScan({
  devices, zones, rules, config,
}) {
  const zoneMap = Object.fromEntries(Object.values(zones).map((zone) => [zone.id, zone.name]));
  // Built once per scan instead of letting findRule re-scan the whole rules array for
  // every single device - see buildRuleIndex.
  const ruleIndex = buildRuleIndex(rules);

  const all = [];
  const notReporting = [];
  const lowBattery = [];
  const excluded = [];

  for (const device of Object.values(devices)) {
    const { rule, ruleApplied } = findRuleIndexed(device, ruleIndex);

    if (rule && (rule.excludeAll || isRulePaused(rule))) {
      excluded.push({ id: device.id, name: device.name, reason: rule.excludeAll ? 'excludeAll' : 'paused' });
      continue;
    }

    const status = computeDeviceStatus(device, rule, config);
    const zoneName = device.zone ? (zoneMap[device.zone] || null) : null;

    const entry = {
      id: device.id,
      name: device.name,
      zone: zoneName,
      class: device.class || null,
      available: device.available !== false,
      lastUpdated: formatDate(status.maxLastUpdatedTime ? new Date(status.maxLastUpdatedTime) : null),
      battery: status.batteryStatus,
      batteryValue: status.batteryValue,
      status: status.isReporting ? 'OK' : 'NOK',
      ruleApplied,
    };

    all.push(entry);

    if (!status.isReporting) notReporting.push(entry);
    if (status.isLowBattery) lowBattery.push(entry);
  }

  return {
    all,
    notReporting,
    lowBattery,
    excluded,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = {
  formatDate,
  findRule,
  buildRuleIndex,
  findRuleIndexed,
  isRulePaused,
  canCheckStaleness,
  computeDeviceStatus,
  runScan,
  safeRegExp,
  buildZoneOrderMap,
};
