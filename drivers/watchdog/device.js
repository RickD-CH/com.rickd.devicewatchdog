'use strict';

const Homey = require('homey');

const ALL_CAPABILITIES = [
  'alarm_generic', 'devices_not_reporting_count', 'devices_unavailable_count', 'devices_low_battery_count',
];

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
      notReporting: this.getCapabilityValue('devices_not_reporting_count') || 0,
      unavailable: this.getCapabilityValue('devices_unavailable_count') || 0,
      lowBattery: this.getCapabilityValue('devices_low_battery_count') || 0,
    };

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
    });

    this.log('Watchdog device initialized', this._counts);
  }

  // Called by app.js after every scan (and, for unavailableCount, on every realtime
  // availability change) - missing values are left untouched, e.g. keeps the low-battery
  // count as-is between scans instead of resetting it while a realtime update comes in.
  async updateCounts({ notReportingCount, unavailableCount, lowBatteryCount } = {}) {
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
      this.setCapabilityValue('devices_not_reporting_count', this._counts.notReporting),
      this.setCapabilityValue('devices_unavailable_count', this._counts.unavailable),
      this.setCapabilityValue('devices_low_battery_count', this._counts.lowBattery),
      this.setCapabilityValue('alarm_generic', alarm),
    ];

    await Promise.all(updates).catch((err) => this.error('Capability-Update fehlgeschlagen:', err));
  }

}

module.exports = WatchdogDevice;
