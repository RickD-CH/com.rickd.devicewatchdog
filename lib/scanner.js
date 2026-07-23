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
 * Global filters that apply regardless of custom rules (zone / owner app / class).
 * Note: `device.driverUri` is deprecated in homey-api v3 and always returns
 * undefined, so we use `device.ownerUri` (format "homey:app:<appId>") instead,
 * which is the equivalent of the old script's EXCLUDED_DRIVER_URI_PATTERN check.
 */
function isExcludedByGlobalFilters(device, zoneMap, config) {
  const ownerPattern = safeRegExp(config.excludedOwnerUriPattern);
  if (ownerPattern && device.ownerUri && ownerPattern.test(device.ownerUri)) return true;

  const zoneName = device.zone ? zoneMap[device.zone] : null;
  const excludedZones = (config.excludedZones || []).map((z) => String(z).toLowerCase());
  if (zoneName && excludedZones.includes(zoneName.toLowerCase())) return true;

  const classPattern = safeRegExp(config.includedDeviceClassPattern);
  if (!device.class || !classPattern || !classPattern.test(device.class)) return true;

  return false;
}

/**
 * Computes reporting + battery status for a single device given its matched rule.
 */
function computeDeviceStatus(device, rule, config) {
  const custom = rule || {};

  let maxLastUpdatedTime = null;
  let isReporting = true;

  if (!custom.onlyCheckBattery) {
    for (const cap of Object.values(device.capabilitiesObj || {})) {
      if (!cap || !cap.lastUpdated) continue;
      const time = new Date(cap.lastUpdated).getTime();
      if (Number.isFinite(time) && time > (maxLastUpdatedTime || 0)) maxLastUpdatedTime = time;
    }

    const thresholdHrs = custom.notReportingDays
      ? custom.notReportingDays * 24
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
function runScan({ devices, zones, rules, config }) {
  const zoneMap = Object.fromEntries(Object.values(zones).map((zone) => [zone.id, zone.name]));

  const all = [];
  const notReporting = [];
  const lowBattery = [];
  const excluded = [];

  for (const device of Object.values(devices)) {
    const { rule, ruleApplied } = findRule(device, rules);

    if (rule && rule.excludeAll) {
      excluded.push({ id: device.id, name: device.name, reason: 'rule' });
      continue;
    }

    if (isExcludedByGlobalFilters(device, zoneMap, config)) {
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
  isExcludedByGlobalFilters,
  computeDeviceStatus,
  runScan,
  safeRegExp,
};
