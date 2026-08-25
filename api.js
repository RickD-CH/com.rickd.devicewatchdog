'use strict';

module.exports = {
  async getConfig({ homey }) {
    return homey.app.getConfig();
  },

  async saveConfig({ homey, body }) {
    return homey.app.saveConfig(body || {});
  },

  async resetSettings({ homey }) {
    return homey.app.resetSettings();
  },

  async getStatus({ homey }) {
    return homey.app.getStatus();
  },

  async getRawDevices({ homey }) {
    return homey.app.getRawDevices();
  },

  async getUnavailableStatus({ homey }) {
    return homey.app.getUnavailableStatus();
  },

  async runScan({ homey }) {
    return homey.app.runScan('settings-ui');
  },

  async testDevice({ homey, params }) {
    return homey.app.testDevice(params.id);
  },

  async getLog({ homey }) {
    return homey.app.getLog();
  },

  async clearLog({ homey }) {
    return homey.app.clearLog();
  },

  async getStaleRules({ homey }) {
    return homey.app.getStaleRules();
  },

  async pruneStaleRules({ homey }) {
    return homey.app.pruneStaleRules();
  },
};
