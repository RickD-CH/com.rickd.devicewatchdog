'use strict';

const Homey = require('homey');

// Order = display order for a newly added device: the total and the latest problem device first, then
// the three single counters, then the "Scan now" button.
// (A device added before devices_problem_count / devices_latest_problem / scan_now existed gets them
// appended last by addCapability - the SDK has no way to reorder, and removing/re-adding the others
// could break Flows using them.)
const ALL_CAPABILITIES = [
  'alarm_generic', 'devices_problem_count', 'devices_latest_problem',
  'devices_not_reporting_count', 'devices_unavailable_count', 'devices_low_battery_count', 'scan_now',
];

// Shown by devices_latest_problem while nothing is wrong.
const NO_PROBLEM_DEVICE = '-';

class WatchdogDevice extends Homey.Device {

  async onInit() {
    // Devices paired against an older app version don't automatically pick up
    // capabilities added later (e.g. alarm_generic, or the counts themselves during
    // earlier development) - self-heal on every start instead of leaving them stuck
    // showing "-" forever for a capability that was never actually added to them.
    for (const cap of ALL_CAPABILITIES) {
      if (!this.hasCapability(cap)) {
        this.log(`Ergänze fehlende Capability: ${cap}`);
        // eslint-disable-next-line no-await-in-loop
        await this.addCapability(cap).catch((err) => this.error(`Capability ${cap} konnte nicht ergänzt werden:`, err));
      }
    }

    this._counts = {
      problem: this.getCapabilityValue('devices_problem_count') || 0,
      notReporting: this.getCapabilityValue('devices_not_reporting_count') || 0,
      unavailable: this.getCapabilityValue('devices_unavailable_count') || 0,
      lowBattery: this.getCapabilityValue('devices_low_battery_count') || 0,
      latest: this.getCapabilityValue('devices_latest_problem') || NO_PROBLEM_DEVICE,
    };

    // The "Scan now" button (also usable as the tile's quick action). Fire and forget: a scan can take
    // a few seconds on a big Homey, which is longer than a button press should wait - the counters
    // update on their own when it is done. A scan already running is joined, not started twice.
    if (this.hasCapability('scan_now')) {
      this.registerCapabilityListener('scan_now', async () => {
        this.homey.app.runScan('virtual-device')
          .catch((err) => this.error('Scan über das virtuelle Gerät fehlgeschlagen:', err));
      });
    }

    // Populate immediately from whatever the app already knows (last scan / current
    // availability map), instead of showing stale/empty values until the next event.
    // lowBatteryCount comes from flagState.lowBatteryConfirmed (delay-gated), not the raw
    // lastScan.lowBattery list - same reasoning as unavailableCount below, see
    // _getLowBatteryDelaySeconds in app.js.
    const { app } = this.homey;
    await this.updateCounts({
      notReportingCount: app.lastScan ? app.lastScan.notReporting.length : 0,
      lowBatteryCount: app.flagState ? (app.flagState.lowBatteryConfirmed || []).length : 0,
      unavailableCount: app._countUnavailable(),
      problemCount: app._countProblemDevices(),
      latestProblemName: app._latestProblemDeviceName(),
    });

    this.log('Watchdog device initialized', this._counts);
  }

  // Called by app.js after every scan (and, for unavailableCount, on every realtime
  // availability change) - missing values are left untouched, e.g. keeps the low-battery
  // count as-is between scans instead of resetting it while a realtime update comes in.
  // problemCount (every device once, see App#_countProblemDevices) and latestProblemName (see
  // App#_latestProblemDeviceName: a name, null = nothing wrong, undefined = not known yet) are sent
  // with every update.
  async updateCounts({
    notReportingCount, unavailableCount, lowBatteryCount, problemCount, latestProblemName,
  } = {}) {
    if (problemCount !== undefined) this._counts.problem = problemCount;
    if (latestProblemName !== undefined) this._counts.latest = latestProblemName === null ? NO_PROBLEM_DEVICE : latestProblemName;
    if (notReportingCount !== undefined) this._counts.notReporting = notReportingCount;
    if (unavailableCount !== undefined) this._counts.unavailable = unavailableCount;
    if (lowBatteryCount !== undefined) this._counts.lowBattery = lowBatteryCount;

    // The counts themselves always reflect the real numbers - only which of them can
    // flip the aggregate alarm is configurable (Einstellungen tab). Undefined (not yet
    // saved by an older config) defaults to included, matching the previous behaviour.
    const { config } = this.homey.app;
    const alarm = (config.alarmIncludesNotReporting !== false && this._counts.notReporting > 0)
      || (config.alarmIncludesUnavailable !== false && this._counts.unavailable > 0)
      || (config.alarmIncludesLowBattery !== false && this._counts.lowBattery > 0);

    const updates = [
      this.setCapabilityValue('devices_problem_count', this._counts.problem),
      this.setCapabilityValue('devices_latest_problem', this._counts.latest),
      this.setCapabilityValue('devices_not_reporting_count', this._counts.notReporting),
      this.setCapabilityValue('devices_unavailable_count', this._counts.unavailable),
      this.setCapabilityValue('devices_low_battery_count', this._counts.lowBattery),
      this.setCapabilityValue('alarm_generic', alarm),
    ];

    await Promise.all(updates).catch((err) => this.error('Capability-Update fehlgeschlagen:', err));
  }

}

module.exports = WatchdogDevice;
