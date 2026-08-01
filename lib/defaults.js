'use strict';

/**
 * Default global configuration.
 * All values can be overridden by the user on the "Allgemein" settings tab.
 */
const DEFAULT_CONFIG = {
  // Base threshold: how many hours a device may stay silent before it's flagged.
  notReportingThresholdHours: 24,
  // Base threshold: battery percentage at/below which a device is flagged.
  batteryThresholdPercent: 30,
  // Automatic scan interval in minutes. Only used when scanIntervalEnabled === true.
  scanIntervalMinutes: 60,
  // If false, no automatic interval scan runs - only manual (Flow action / settings button).
  scanIntervalEnabled: true,
  // No global exclusion filters (zone/owner-app/class) by design - every device is
  // scanned by default. Excluding individual devices or whole zones happens explicitly
  // via the per-device toggle / "Zone ignorieren" bulk action in the Settings UI.
  // If true, writes a Homey Timeline entry the moment a device newly becomes a problem
  // (same edge-triggered semantics as the Flow triggers) - never repeats for the same
  // ongoing problem, to avoid spamming the timeline.
  timelineNotifications: false,
  // Which categories feed into the virtual Watchdog device's alarm_generic capability.
  // The three count capabilities themselves always show the real numbers regardless -
  // this only filters what flips the aggregate alarm, e.g. to ignore battery warnings
  // there but still see them in the counts / other Flow cards.
  alarmIncludesUnavailable: true,
  alarmIncludesNotReporting: true,
  alarmIncludesLowBattery: true,
  // Grace period before a device that just went unavailable counts as confirmed
  // (Flow trigger, log, summary, Timeline, and the virtual device's count/alarm all
  // wait for this). 0 = instant, same as before this existed. Meant for cases like an
  // app update briefly disconnecting all its devices - not a real problem worth a Flow
  // firing or an alert, if it recovers within the grace period.
  unavailableDelaySeconds: 0,
  // Settings UI only: lightens secondary/muted text further in dark mode, for users
  // who find the default dark-mode gray too low-contrast in bright light.
  highContrastText: false,
  // If true, "not reporting" also treats Homey's own lastSeenAt as a sign of life,
  // not just capability value changes - whichever is newer counts. CAVEAT (confirmed
  // against real devices, see community thread): for most devices lastSeenAt only
  // moves in lockstep with the last real capability update anyway, so this ends up a
  // no-op more often than not - it only actually helps the minority of devices whose
  // lastSeenAt is genuinely updated independently of their reported capability data.
  // Off by default: capability-only detection also catches a device that's connected
  // but whose data itself is stuck, which this would miss.
  includeLastSeenForReporting: false,
};

/**
 * Rules array is empty by default - the user builds it up via the settings page.
 * Shape of a single rule:
 * {
 *   id: 'uuid',
 *   matchType: 'id' | 'name' | 'pattern',
 *   matchValue: string,
 *   label: string,               // free-text note, e.g. device name for readability
 *   notReportingHours: number|null,
 *   batteryThreshold: number|null,
 *   excludeBattery: boolean,
 *   onlyCheckBattery: boolean,
 *   excludeAll: boolean,
 *   excludeFromUnavailable: boolean,
 *   unavailableDelaySeconds: number|null,
 *   includeLastSeenForReporting: boolean|null,  // null = inherit the global setting
 *   pausedUntil: string|null,    // ISO date "YYYY-MM-DD"; paused through end of that day
 * }
 */
const DEFAULT_RULES = [];

module.exports = {
  DEFAULT_CONFIG,
  DEFAULT_RULES,
};
