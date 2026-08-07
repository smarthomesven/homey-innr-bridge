'use strict';

const Homey = require('homey');
const InnrApi = require('./lib/api');
const InnrMqttClient = require('./lib/mqtt');

module.exports = class InnrBridgeApp extends Homey.App {

  async onInit() {
    this.log('Innr Bridge app initializing');

    this.api = new InnrApi({
      settings: this.homey.settings,
      log: this.log.bind(this),
    });

    this.mqtt = new InnrMqttClient({
      getConfig: this._buildMqttConfig.bind(this),
      log: this.log.bind(this),
      error: this.error.bind(this),
    });

    // Route incoming attribute updates to whichever device registers interest.
    // Devices subscribe via app.onAttrUpdate() in their onInit().
    this._attrListeners = new Set();
    this.mqtt.on('attr', (devId, attr) => {
      for (const cb of this._attrListeners) {
        try { cb(devId, attr); } catch (err) { this.error(err); }
      }
    });

    // Only auto-connect if we already have a session (i.e. not first install/pre-pairing).
    if (this.homey.settings.get('accessToken') && this.homey.settings.get('refreshToken')) {
      await this._startMqtt().catch((err) => this.error('Startup MQTT connect failed:', err.message || err));
    } else {
      this.log('No stored session yet — MQTT will start after pairing/login');
    }

    this.log('Innr Bridge app initialized');
  }

  /**
   * Builds fresh MQTT connect params. Called on first connect and on every
   * reconnect by InnrMqttClient, so a rotated mqttConfig.password is always
   * picked up without needing a full app restart.
   */
  async _buildMqttConfig() {
    const houseId = this.homey.settings.get('houseId');
    if (!houseId) {
      throw new Error('No houseId stored yet — getAllDevices() must run before MQTT can connect');
    }
    this.log('[InnrBridgeApp] fetching mqttConfig for houseId', houseId);
    const mqttConfig = await this.api.getMqttConfig(houseId);
    this.log('[InnrBridgeApp] mqttConfig received:', mqttConfig);
    return {
      host: mqttConfig.host,
      userId: this.homey.settings.get('userId'),
      terminalIndex: this.homey.settings.get('terminalIndex') || mqttConfig.clientId?.split('-')[0],
      mqttPassword: mqttConfig.password,
      heartbeat: mqttConfig.heartbeat,
    };
  }

  /**
   * Fetches the current device list (for gateway/password routing info and to
   * populate settings.houseId, which _buildMqttConfig needs), registers it with
   * the MQTT client, then connects. Order matters: devices must be fetched first.
   * Call this after login, and it's also called automatically on startup.
   */
  async _startMqtt() {
    const devices = await this.api.getAllDevices();
    this.mqtt.registerDevices(devices);
    await this.mqtt.connect();
  }

  /** Called by the driver once login succeeds during pairing. */
  async onLoggedIn() {
    await this._startMqtt();
  }

  /** Devices call this in onInit() to receive setDevAttrNotif updates for their devId. */
  onAttrUpdate(cb) {
    this._attrListeners.add(cb);
    return () => this._attrListeners.delete(cb);
  }

  /** Re-fetches the device list and re-registers it with the MQTT client (e.g. after repair or new device added). */
  async refreshDeviceRegistry() {
    const devices = await this.api.getAllDevices();
    this.mqtt.registerDevices(devices);
  }

  async onUninit() {
    this.mqtt?.disconnect();
  }

};