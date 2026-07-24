'use strict';

const Homey = require('homey');

// Single virtual "status" device - exposes the app's counts as capabilities so they
// show up in Homey Insights/dashboards and are usable in Flows without our own cards.
// The pair flow only ever offers this one fixed device, added once via the normal
// Homey "add device" UI (a real device still needs to be user-added, not auto-created).
class WatchdogDriver extends Homey.Driver {

  async onPairListDevices() {
    // "Device Watchdog" is already identical in both supported languages (see app.json),
    // so this can be a plain string instead of needing its own locale lookup.
    return [
      {
        name: 'Device Watchdog',
        data: { id: 'watchdog-status' },
      },
    ];
  }

}

module.exports = WatchdogDriver;
