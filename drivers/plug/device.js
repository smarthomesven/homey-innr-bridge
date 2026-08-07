'use strict';

const Homey = require('homey');

module.exports = class PlugDevice extends Homey.Device {

  async onInit() {
    this.log('Plug device initialized:', this.getName());

    const { id: devId } = this.getData();
    const { password, parentId } = this.getStore();

    // Make sure the shared MQTT client knows how to route commands for this
    // device even if the app-level device list fetch hasn't included it yet
    // (e.g. device object created before a full refreshDeviceRegistry()).
    this.homey.app.mqtt.deviceGatewayMap.set(devId, parentId);
    this.homey.app.mqtt.devicePasswordMap.set(devId, password);

    this._unregisterAttrListener = this.homey.app.onAttrUpdate((updatedDevId, attr) => {
      if (updatedDevId !== devId) return;
      if ('OnOff' in attr) {
        this.setCapabilityValue('onoff', attr.OnOff === 1).catch(this.error);
      }
    });

    if (this.hasCapability('onoff')) {
      this.registerCapabilityListener('onoff', async (value) => {
        this.homey.app.mqtt.setAttr(devId, { OnOff: value ? 1 : 0 });
      });
    }
  }

  async onAdded() {
    this.log('Plug device has been added:', this.getName());
    // Make sure the new device's routing info is available immediately,
    // in case it was paired after the app's last device-list refresh.
    await this.homey.app.refreshDeviceRegistry().catch(this.error);
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('Plug device settings were changed:', changedKeys);
  }

  async onRenamed(name) {
    this.log('Plug device was renamed to:', name);
  }

  async onDeleted() {
    this.log('Plug device has been deleted:', this.getName());
    this._unregisterAttrListener?.();
    const { id: devId } = this.getData();
    this.homey.app.mqtt.deviceGatewayMap.delete(devId);
    this.homey.app.mqtt.devicePasswordMap.delete(devId);
  }

};