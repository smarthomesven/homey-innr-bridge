const axios = require('axios');
module.exports = {
  async getDebugData({ homey }) {
    const app = homey.app;
    const devices = await app.api.getAllDevices();
    return devices.map(device => ({
      siteId: device.id,
      siteName: device.name || device.friendlyName || device.id,
      clients: device,
    }));
  },
  async startMqttCapture({ homey, body }) {
    const { deviceId } = body;
    if (!deviceId) throw new Error('Missing deviceId');
    homey.app.startDebugCapture(deviceId);
    return { success: true };
  },
  async stopMqttCapture({ homey, body }) {
    const { deviceId } = body;
    if (!deviceId) throw new Error('Missing deviceId');
    const count = homey.app.stopDebugCapture(deviceId);
    return { success: true, count };
  },
  async send({ homey, body }) {
    try {
      const { message, deviceId, deviceName, data } = body;
      if (!message || !data) {
        throw new Error('Missing required fields');
      }
      const mqttMessages = deviceId ? homey.app.getDebugMessages(deviceId) : [];
      const response = await axios.post('https://device-support-requests.vercel.app/api/send-report', {
        message: message,
        app: 'Innr Bridge',
        report: {
          deviceId: deviceId,
          deviceName: deviceName,
          data: data,
          mqttMessages: mqttMessages,
        }
      });
      // Clear the capture after a successful send so a later send doesn't
      // resubmit stale messages from a previous session.
      if (deviceId) homey.app.clearDebugCapture(deviceId);
      return {
        success: true,
        id: response.data.id
      };
    } catch (error) {
      homey.app.error('Error sending to support:', error.message);
      throw new Error(error.response?.data?.error || error.message);
    }
  }
};