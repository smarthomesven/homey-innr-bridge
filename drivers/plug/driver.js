'use strict';

const Homey = require('homey');

module.exports = class PlugDriver extends Homey.Driver {

  async onInit() {
    this.log('Plug driver has been initialized');
  }

  async onPair(session) {
    session.setHandler('login', async (data) => {
      try {
        const { email, password, region } = data;
        const existingToken = this.homey.settings.get('accessToken');

        if (existingToken) {
          this.log('Access token already exists, skipping login.');
        } else {
          await this.homey.app.api.login(email, password, region);
          this.log('Login successful, region:', this.homey.app.api.getRegion());
        }

        // Bring MQTT up now (idempotent) so list_devices + later pairing work off a live session
        await this.homey.app.onLoggedIn();

        await session.showView('list_devices');
      } catch (error) {
        this.error('Error during login:', error.message || error);
        throw new Error('Login failed: ' + error.message);
      }
    });

    session.setHandler('list_devices', async () => {
      return this.onPairListDevices();
    });
  }

  /**
   * Returns plugs formatted for Homey pairing.
   * `store` carries everything InnrMqttClient needs for this device without
   * requiring a fresh device-list fetch at runtime: its own MQTT password,
   * and the gateway (parentId) it must publish setDevAttrReq to.
   */
  async onPairListDevices() {
    const devices = await this.homey.app.api.getAllDevices();

    return devices
      .filter((device) => device.type === 'plug')
      .map((device) => ({
        name: device.name,
        data: {
          id: device.id, // the plug's own id — used as devId in MQTT payloads
        },
        store: {
          houseId: device.houseId,
          model: device.modelId,
          mac: device.mac,
          password: device.password, // per-device MQTT password (setDevAttrReq.payload.password)
          parentId: device.parentId || device.id, // gateway id — topic to publish setDevAttrReq to
        },
      }));
  }

};