'use strict';

/**
 * Pure helpers for the "value hasn't changed for N minutes" Flow trigger (no Homey calls,
 * so they can be unit tested). The stateful part - timers, firing - lives in app.js.
 */

const UNIT_MS = { minutes: 60 * 1000, hours: 60 * 60 * 1000 };
const MAX_WATCH_MS = 365 * 24 * 60 * 60 * 1000;

// Capabilities that never carry a meaningful "last changed" time (momentary, stateless).
const NOT_WATCHABLE_BASES = ['button'];

// "15 minutes" -> 900000. Null for anything that isn't a positive amount of a known unit.
function watchDurationMs(amount, unit) {
  const factor = UNIT_MS[unit];
  const count = Number(amount);
  if (!factor || !Number.isFinite(count) || count <= 0) return null;
  const ms = count * factor;
  return ms <= MAX_WATCH_MS ? ms : null;
}

function watchKey(deviceId, capabilityId, durationMs) {
  return `${deviceId}|${capabilityId}|${durationMs}`;
}

// One watch per distinct (device, value, duration) that at least one Flow uses.
// `argumentValues` is what FlowCardTrigger#getArgumentValues() returns: one entry per Flow.
function desiredWatches(argumentValues) {
  const watches = new Map();
  for (const args of argumentValues || []) {
    const deviceId = args && args.device && args.device.id;
    const capabilityId = args && args.capability && args.capability.id;
    const durationMs = watchDurationMs(args && args.amount, args && args.unit);
    if (!deviceId || !capabilityId || durationMs === null) continue;
    watches.set(watchKey(deviceId, capabilityId, durationMs), { deviceId, capabilityId, durationMs });
  }
  return watches;
}

// Does a Flow's arguments belong to the freeze that was just detected? (run listener)
function watchMatches(args, state) {
  return !!(args && state && args.device && args.capability
    && args.device.id === state.deviceId
    && args.capability.id === state.capabilityId
    && watchDurationMs(args.amount, args.unit) === state.durationMs);
}

// When Homey last changed this value, as epoch ms (null if the device has no such value/time).
function capabilityLastUpdatedMs(device, capabilityId) {
  const capability = device && device.capabilitiesObj && device.capabilitiesObj[capabilityId];
  if (!capability || !capability.lastUpdated) return null;
  const ms = new Date(capability.lastUpdated).getTime();
  return Number.isFinite(ms) ? ms : null;
}

// Capability titles come as a plain string or as a per-language object.
function capabilityTitle(capability, capabilityId, language = 'en') {
  const title = capability && capability.title;
  if (typeof title === 'string' && title) return title;
  if (title && typeof title === 'object') {
    const text = title[language] || title.en || Object.values(title).find((v) => typeof v === 'string' && v);
    if (text) return text;
  }
  return capabilityId;
}

function formatCapabilityValue(capability) {
  if (!capability || capability.value === undefined || capability.value === null) return '';
  const units = typeof capability.units === 'string' && capability.units ? ` ${capability.units}` : '';
  return `${capability.value}${units}`;
}

// Autocomplete list of the values a device offers, filtered by what the user typed.
function capabilityChoices(device, query, language = 'en') {
  const q = String(query || '').toLowerCase();
  return Object.entries((device && device.capabilitiesObj) || {})
    .filter(([id]) => !NOT_WATCHABLE_BASES.includes(String(id).split('.')[0]))
    .map(([id, capability]) => {
      const name = capabilityTitle(capability, id, language);
      const current = formatCapabilityValue(capability);
      return {
        id, name, description: current ? `${id} - ${current}` : id,
      };
    })
    .filter((choice) => !q || choice.name.toLowerCase().includes(q) || choice.id.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = {
  watchDurationMs,
  watchKey,
  desiredWatches,
  watchMatches,
  capabilityLastUpdatedMs,
  capabilityTitle,
  formatCapabilityValue,
  capabilityChoices,
};
