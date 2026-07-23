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
  // Zone names (lowercase) to fully ignore, e.g. "n-a".
  excludedZones: ['n-a'],
  // Devices whose owning app id (device.ownerUri) matches this pattern are ignored
  // (virtual devices, helper apps, groups, etc.). Empty string disables this filter.
  excludedOwnerUriPattern: 'vdevice|nl\\.qluster-it\\.DeviceCapabilities|nl\\.fellownet\\.chronograph|net\\.i-dev\\.betterlogic|com\\.swttt\\.devicegroups|com\\.gruijter\\.callmebot|com\\.netscan',
  // Empty = no class restriction, every device class is scanned. Monitoring per device
  // is controlled directly via the toggle in the Settings UI instead of a class whitelist -
  // a whitelist would otherwise silently drop devices with unusual/new classes.
  includedDeviceClassPattern: '',
};

/**
 * Rules array is empty by default - the user builds it up via the settings page.
 * Shape of a single rule:
 * {
 *   id: 'uuid',
 *   matchType: 'id' | 'name' | 'pattern',
 *   matchValue: string,
 *   label: string,               // free-text note, e.g. device name for readability
 *   notReportingDays: number|null,
 *   batteryThreshold: number|null,
 *   excludeBattery: boolean,
 *   onlyCheckBattery: boolean,
 *   excludeAll: boolean,
 * }
 */
const DEFAULT_RULES = [];

module.exports = {
  DEFAULT_CONFIG,
  DEFAULT_RULES,
};
