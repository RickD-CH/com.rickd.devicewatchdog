'use strict';

module.exports = {
  async getSummary({ homey }) {
    return homey.app.getWidgetSummary();
  },

  async runScan({ homey, body }) {
    // The scan the widget fires just by being opened isn't a deliberate request - during the
    // startup grace period it must not run, or it defeats the "wait after app start" setting
    // (every dashboard opened right after a Homey restart flagged a burst of false positives).
    if (body && body.onOpen && homey.app.isInStartupGrace() && homey.app.lastScan) {
      return homey.app.lastScan;
    }
    return homey.app.runScan('widget');
  },
};
