'use strict';
const mqtt = require('mqtt');
const EventEmitter = require('events');
class InnrMqttClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {Function} opts.getConfig - async () => { host, userId, terminalIndex, mqttPassword, heartbeat }
   *   Called on first connect AND on every reconnect, so a rotated mqttConfig.password is always picked up.
   * @param {Function} [opts.log]
   * @param {Function} [opts.error]
   */
  constructor({ getConfig, log = () => {}, error = () => {} }) {
    super();
    this.getConfig = getConfig;
    this.log = log;
    this.error = error;
    this.client = null;
    this.deviceGatewayMap = new Map(); // devId -> gatewayId (parentId)
    this.devicePasswordMap = new Map(); // devId -> per-device password
    this._userId = null;
    this._connecting = false;
    // --- Debug capture: devId -> { active: bool, messages: [] } ---
    this._debugCaptures = new Map();
  }
  registerDevices(deviceList) {
    for (const dev of deviceList) {
      this.deviceGatewayMap.set(dev.id, dev.parentId || dev.id);
      this.devicePasswordMap.set(dev.id, dev.password);
    }
  }
  /** Connect, or reconnect with fresh credentials. Safe to call repeatedly. */
  async connect() {
    if (this._connecting) return;
    this._connecting = true;
    try {
      // Tear down any previous connection first so we don't leak sockets
      if (this.client) {
        this.client.removeAllListeners();
        this.client.end(true);
        this.client = null;
      }
      const config = await this.getConfig();
      this._userId = config.userId;
      const clientId = `${config.terminalIndex}-${config.userId}`;
      const url = `wss://${config.host}/mqtt`;
      this.client = mqtt.connect(url, {
        clientId,
        username: config.userId,
        password: config.mqttPassword,
        keepalive: config.heartbeat || 45,
        protocolVersion: 4,
        clean: true,
        reconnectPeriod: 0, // we drive reconnects ourselves — see _scheduleReconnect
        connectTimeout: 10 * 1000,
      });
      this.client.on('connect', () => {
        this.log('[Innr MQTT] connected');
        this._announceConnect();
        this._subscribeAll();
        this.emit('connect');
      });
      this.client.on('message', (topic, payload) => this._handleMessage(topic, payload));
      this.client.on('close', () => {
        this.log('[Innr MQTT] connection closed');
        this.emit('close');
        this._scheduleReconnect();
      });
      this.client.on('error', (err) => {
        this.error('[Innr MQTT] error', err.message || err);
        // 'close' fires after 'error' for connection failures, so reconnect is scheduled there
      });
    } finally {
      this._connecting = false;
    }
  }
  /**
   * Observed real-app behaviour: connection drops roughly every ~30s
   * (server-side idle/session timeout), then the app waits ~0.5s and reconnects.
   * We mirror that instead of mqtt.js's built-in backoff, and re-fetch credentials
   * each time in case the session's mqttConfig.password rotated.
   */
  _scheduleReconnect() {
    if (this._reconnectTimer) return; // already scheduled
    this._reconnectTimer = this.homeySetTimeout(() => {
      this._reconnectTimer = null;
      this.connect().catch((err) => this.error('[Innr MQTT] reconnect failed', err.message || err));
    }, 500);
  }
  // Overridable so the app can inject this.homey.setTimeout if it wants Homey's managed timers.
  homeySetTimeout(fn, ms) {
    return setTimeout(fn, ms);
  }
  disconnect() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (!this.client) return;
    this._publish(`iot/v1/cb/${this._userId}/user/disconnect`, {
      service: 'user',
      method: 'disconnect',
      seq: this._genSeq(),
      srcAddr: `0.${this._userId}`,
      payload: { timestamp: this._timestamp() },
    });
    this.client.removeAllListeners();
    this.client.end();
    this.client = null;
  }
  _announceConnect() {
    this._publish(`iot/v1/cb/${this._userId}/user/connect`, {
      service: 'user',
      method: 'connect',
      payload: { timestamp: this._timestamp() },
      seq: this._genSeq(),
      srcAddr: `0.${this._userId}`,
    });
  }
  _subscribeAll() {
    this.client.subscribe(`iot/v1/c/${this._userId}/#`, { qos: 1 });
    const targets = new Set(this.deviceGatewayMap.values());
    for (const devId of this.deviceGatewayMap.keys()) targets.add(devId);
    for (const id of targets) {
      this.client.subscribe(`iot/v1/cb/${id}/#`, { qos: 1 });
    }
  }
  _handleMessage(topic, payloadBuf) {
    const rawPayload = payloadBuf.toString();
    // --- Debug capture: record raw messages for any devId under active capture ---
    // All Innr traffic already flows through the wildcard subscriptions set up in
    // _subscribeAll(), so unlike a per-thing AWS IoT topic there's nothing extra to
    // subscribe to here — we just tap the already-flowing message stream and match
    // active captures against whichever devId(s) the payload mentions.
    if (this._debugCaptures.size > 0) {
      this._recordDebugMessage(topic, rawPayload);
    }
    let msg;
    try {
      msg = JSON.parse(rawPayload);
    } catch (err) {
      this.error('[Innr MQTT] bad JSON payload', topic, err.message);
      return;
    }
    if (msg.service === 'device' && msg.method === 'setDevAttrNotif') {
      const { devId, attr } = msg.payload || {};
      if (devId && attr) this.emit('attr', devId, attr);
    }
  }
  _recordDebugMessage(topic, rawPayload) {
    let devId = null;
    try {
      const parsed = JSON.parse(rawPayload);
      devId = parsed?.payload?.devId || null;
    } catch (err) {
      // Non-JSON or unrelated payload — still capture below for any device whose
      // gatewayId matches the topic, since some messages are gateway-scoped rather
      // than device-scoped.
    }
    const MAX_DEBUG_MESSAGES = 500;
    const entry = { topic, payload: rawPayload, timestamp: Date.now() };
    for (const [id, capture] of this._debugCaptures) {
      if (!capture.active) continue;
      const gatewayId = this.deviceGatewayMap.get(id);
      const matchesDevice = devId === id;
      const matchesGateway = gatewayId && topic.includes(`/${gatewayId}/`);
      if (matchesDevice || matchesGateway) {
        capture.messages.push(entry);
        if (capture.messages.length > MAX_DEBUG_MESSAGES) {
          capture.messages.splice(0, capture.messages.length - MAX_DEBUG_MESSAGES);
        }
      }
    }
  }
  startDebugCapture(devId) {
    this._debugCaptures.set(devId, { active: true, messages: [] });
    this.log(`[Innr MQTT] Started debug capture for ${devId}`);
    return true;
  }
  stopDebugCapture(devId) {
    const capture = this._debugCaptures.get(devId);
    if (capture) capture.active = false;
    this.log(`[Innr MQTT] Stopped debug capture for ${devId}`);
    return capture ? capture.messages.length : 0;
  }
  getDebugMessages(devId) {
    const capture = this._debugCaptures.get(devId);
    return capture ? capture.messages : [];
  }
  clearDebugCapture(devId) {
    this._debugCaptures.delete(devId);
  }
  setAttr(devId, attr) {
    const gatewayId = this.deviceGatewayMap.get(devId);
    const devicePassword = this.devicePasswordMap.get(devId);
    if (!gatewayId || !devicePassword) {
      throw new Error(`Unknown devId ${devId} — call registerDevices() first`);
    }
    if (!this.client || !this.client.connected) {
      throw new Error('MQTT client not connected');
    }
    const topic = `iot/v1/c/${gatewayId}/device/setDevAttrReq`;
    const message = {
      method: 'setDevAttrReq',
      service: 'device',
      seq: this._genSeq(),
      tst: Date.now(),
      payload: {
        devId,
        parentId: gatewayId,
        userId: this._userId,
        password: devicePassword,
        attr,
      },
      srcAddr: `0.${this._userId}`,
    };
    this._publish(topic, message, { qos: 1 });
  }
  _publish(topic, obj, opts = { qos: 1 }) {
    if (!this.client) return;
    this.client.publish(topic, JSON.stringify(obj), opts);
  }
  _genSeq() {
    return String(Math.floor(Math.random() * 1e9)).padStart(9, '0');
  }
  _timestamp() {
    const d = new Date();
    const pad = (n, len = 2) => String(n).padStart(len, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} `
      + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`;
  }
}
module.exports = InnrMqttClient;