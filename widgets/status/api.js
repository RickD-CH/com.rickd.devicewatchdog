'use strict';

module.exports = {
  async getSummary({ homey }) {
    return homey.app.getWidgetSummary();
  },

  async runScan({ homey }) {
    return homey.app.runScan('widget');
  },
};
