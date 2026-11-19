'use strict';

/**
 * Per-device rule shape + persistence sanitizing, split out of app.js (and kept free of
 * any Homey / HomeyAPI calls, same rationale as lib/scanner.js) so it can be unit tested
 * without the Homey runtime.
 *
 * sanitizeRule() is the exact whitelist app.js's saveConfig applies to every rule before
 * persisting it. This used to live inline in app.js as an object literal - the one spot
 * that silently dropped a brand new field (autoTestOnStale/autoTestTriggerOnHeal) when it
 * was added elsewhere (UI, defaults) without also being added here. A round-trip test
 * against DEFAULT_RULES's documented shape (see test/rules.test.js) now catches that
 * class of bug the moment a new field is introduced, instead of only once someone notices
 * the setting silently "doing nothing" in the running app.
 */

function generateId() {
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function positiveNumberOrNull(value) {
  if (value === '' || value === undefined || value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Unlike positiveNumberOrNull above, 0 is a valid, meaningful value here ("no delay,
// confirm instantly") rather than "unset".
function nonNegativeNumberOrNull(value) {
  if (value === '' || value === undefined || value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// Tri-state per-device override for a setting that also has a global default: null means
// "inherit the global config value", true/false explicitly overrides it.
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

// Mirrors app.js's safetyFactorOrDefault clamp range [1.0, 5.0] - null means "inherit the
// global recommendationSafetyFactor"; an explicit override still can't go below 1.0 (would
// suggest a threshold shorter than an already-observed gap) or above 5.0 (typo territory).
function safetyFactorOrNull(value) {
  if (value === '' || value === undefined || value === null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.min(5, Math.max(1, n)) * 100) / 100;
}

// null = inherit the global recommendationBasis; 'max'/'avg' explicitly overrides it.
function basisOrNull(value) {
  return (value === 'max' || value === 'avg') ? value : null;
}

// A pause without an end date ("Pause device until resumed"): stored as a date so every
// consumer (scanner, UI, Apply-to-same-type) keeps working on plain dates; the UI shows it as
// "until resumed". Date-only = through the end of that day, which no Homey will ever reach.
const PAUSE_UNTIL_RESUMED = '9999-12-31';

function isIndefinitePause(value) {
  return value === PAUSE_UNTIL_RESUMED;
}

// Year first, or day first (read as European order, like the long-standing dd-mm-yyyy of
// Homey's own date-picker argument); "-", "/" and "." between the parts; an optional time
// after a space or a T, optionally with seconds. Month, day and hour may have one digit.
const DATE_YEAR_FIRST = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ]+(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?$/;
const DATE_DAY_FIRST = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:[T ]+(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?$/;

// Settings UI's <input type="datetime-local"> sends "YYYY-MM-DDTHH:mm" (older saves, and
// the Flow variable card, may also have a bare "YYYY-MM-DD"). Homey's own native Flow
// date-picker argument, however, presents/passes "dd-mm-yyyy", and a "Format date" card in
// another app easily produces "yyyy/MM/dd HH:mm" (forum report: it silently paused nothing) -
// accept all of them here (shared by saveConfig and the Flow actions), normalizing to
// "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm" so isRulePaused only ever has those two formats to
// parse. Anything else (including garbage from a direct API call, or an unresolved/malformed
// token on the text-based Flow variant) yields null rather than corrupting the scan loop
// with an unparsable date - callers decide what null means (see App#pauseDevice).
function isoDateOrNull(value) {
  if (value === '' || value === undefined || value === null) return null;
  const text = String(value).trim();

  let year; let month; let day; let hour; let minute;
  const yearFirst = DATE_YEAR_FIRST.exec(text);
  const dayFirst = yearFirst ? null : DATE_DAY_FIRST.exec(text);
  if (yearFirst) [, year, month, day, hour, minute] = yearFirst;
  else if (dayFirst) [, day, month, year, hour, minute] = dayFirst;
  else return null;

  const y = Number(year);
  const mo = Number(month);
  const d = Number(day);
  // Round trip: Date.UTC rolls 31 February over into March, which must stay invalid.
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;

  const pad = (n) => String(n).padStart(2, '0');
  const isoDate = `${String(y).padStart(4, '0')}-${pad(mo)}-${pad(d)}`;
  if (hour === undefined) return isoDate;

  const h = Number(hour);
  const mi = Number(minute);
  if (h > 23 || mi > 59) return null;
  return `${isoDate}T${pad(h)}:${pad(mi)}`;
}

// Free text, trimmed; empty/whitespace-only collapses to null (same "unset" semantics as
// every other nullable per-device field) rather than storing a blank string forever.
function trimmedOrNull(value) {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed === '' ? null : trimmed;
}

// The full whitelist of persistable per-device rule fields. Every field a rule can carry
// MUST be listed here - anything not listed is silently dropped on save. Keep this in
// sync with the shape documented in lib/defaults.js.
function sanitizeRule(rule) {
  return {
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
    lowBatteryDelaySeconds: nonNegativeNumberOrNull(rule.lowBatteryDelaySeconds),
    includeLastSeenForReporting: boolOrNull(rule.includeLastSeenForReporting),
    includeBatteryForReporting: rule.includeBatteryForReporting !== false,
    pausedUntil: isoDateOrNull(rule.pausedUntil),
    batteryTypeOverride: trimmedOrNull(rule.batteryTypeOverride),
    autoTestOnStale: !!rule.autoTestOnStale,
    autoTestTriggerOnHeal: !!rule.autoTestTriggerOnHeal,
    dismissedRecommendedHours: positiveNumberOrNull(rule.dismissedRecommendedHours),
    recommendationSafetyFactor: safetyFactorOrNull(rule.recommendationSafetyFactor),
    recommendationBasis: basisOrNull(rule.recommendationBasis),
  };
}

// Joins the native date argument of "Pause device until date and time" ("dd-mm-yyyy", or ISO)
// with its time argument ("HH:mm") into a pausedUntil value. A missing or unusable time falls
// back to the bare date (paused through the end of that day); an unusable date means no pause.
function combineDateAndTime(date, time) {
  const isoDate = isoDateOrNull(date);
  if (!isoDate) return null;
  const dateOnly = isoDate.slice(0, 10);
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(time === undefined || time === null ? '' : time).trim());
  if (!match) return dateOnly;
  return `${dateOnly}T${match[1].padStart(2, '0')}:${match[2]}`;
}

module.exports = {
  combineDateAndTime,
  generateId,
  positiveNumberOrNull,
  nonNegativeNumberOrNull,
  boolOrNull,
  percentOrNull,
  isoDateOrNull,
  isIndefinitePause,
  PAUSE_UNTIL_RESUMED,
  trimmedOrNull,
  safetyFactorOrNull,
  basisOrNull,
  sanitizeRule,
};
