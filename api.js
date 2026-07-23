module.exports = {
  async getConfig({ homey }) {
    return homey.app.getConfig();
  },

  async saveConfig({ homey, body }) {
    return homey.app.saveConfig(body || {});
  },

  async getStatus({ homey }) {
    return homey.app.getStatus();
  },

  async getRawDevices({ homey }) {
    return homey.app.getRawDevices();
  },

  async runScan({ homey }) {
    return homey.app.runScan('settings-ui');
  },
};
