'use strict';

const axios = require('axios');
const crypto = require('crypto');

const APP_ID = '1260140618008576002';
const USER_AGENT = 'Mozilla/5.0 (Linux; Android 13; SM-A515F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.6943.137 Mobile Safari/537.36 Leedarson';
const DEFAULT_REGION = 'eu';

class InnrApi {

  /**
   * @param {object} opts
   * @param {Homey.Settings} opts.settings - this.homey.settings
   * @param {Function} [opts.log]
   */
  constructor({ settings, log = () => {} }) {
    this.settings = settings;
    this.log = log;
  }

  /** Lowercased region code, e.g. "eu". Stored at login; defaults to eu until then. */
  getRegion() {
    return (this.settings.get('region') || DEFAULT_REGION).toLowerCase();
  }

  setRegion(region) {
    this.settings.set('region', (region || DEFAULT_REGION).toLowerCase());
  }

  get baseUrl() {
    return `https://prod-${this.getRegion()}-api.arnoo.com/v17`;
  }

  _baseHeaders(extra = {}) {
    return {
      'User-Agent': USER_AGENT,
      'Origin': 'https://127.0.0.1:10501',
      'Referer': 'https://127.0.0.1:10501/',
      'appId': APP_ID,
      'locale': 'en-US',
      'terminal': 'app',
      'start': Date.now().toString(),
      'traceId': this._genTraceId(),
      'webVersion': '2.6.3',
      'X-Requested-With': 'com.innr.lcng',
      ...extra,
    };
  }

  /** Matches observed format "YYYY-MM-DD HH:mm:ss.SSS.NNNNNN" (ms + 6-digit sub-ms counter/random). */
  _genTraceId() {
    const d = new Date();
    const pad = (n, len = 2) => String(n).padStart(len, '0');
    const ts = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} `
      + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`;
    const suffix = String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
    return `${ts}.${suffix}`;
  }

  _authHeaders() {
    const accessToken = this.settings.get('accessToken');
    const userId = this.settings.get('userId');
    return this._baseHeaders({
      token: accessToken,
      owner: userId,
    });
  }

  getTerminalId() {
    let terminalId = this.settings.get('terminalId');
    if (!terminalId) {
      terminalId = this._generateTerminalId();
      this.settings.set('terminalId', terminalId);
    }
    return terminalId;
  }

  _generateTerminalId(size = 21) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
    const bytes = crypto.randomBytes(size);
    let id = '';
    for (let i = 0; i < size; i++) id += alphabet[bytes[i] % alphabet.length];
    return id;
  }

  /**
   * @param {string} email
   * @param {string} password
   * @param {string} [region] - e.g. "EU". Defaults to "eu" if not provided. Stored for all subsequent requests (including MQTT host).
   * @returns {Promise<object>} raw login response
   */
  async login(email, password, region) {
    this.setRegion(region.toLowerCase());
    let countryKey;
    if (region.toLowerCase() === 'eu') {
      countryKey = 'region:Netherlands';
    } else if (region.toLowerCase() === 'us') {
      countryKey = 'region:United States';
    }

    const response = await axios.post(`${this.baseUrl}/users/loginWithEmailPassword`, {
      username: email,
      password: crypto.createHash('md5').update(password).digest('hex'),
      countryKey: countryKey,
      nativeVersion: '2.6.2',
      buildNumber: 2012251589,
      osVersion: '16',
      os: 2,
      packName: 'com.innr.lcng',
      terminalModelName: 'samsung/SM-A515F',
      terminalName: 'Galaxy A51',
      terminalId: this.getTerminalId(),
      area: 'GMT',
      webVersion: '2.6.3',
      webViewVersion: '133.0.6943.137',
    }, { headers: this._baseHeaders() });

    const data = response.data;
    if (!data.accessToken || !data.refreshToken || !data.id) {
      throw new Error('Login failed: invalid response from server');
    }

    this.settings.set('accessToken', data.accessToken);
    this.settings.set('refreshToken', data.refreshToken);
    this.settings.set('userId', data.id);
    this.settings.set('terminalIndex', data.terminalIndex);

    return data;
  }

  /**
   * Refreshes accessToken using the stored refreshToken.
   * refreshToken itself is not rotated by this endpoint.
   * @returns {Promise<string>} the new accessToken
   */
  async refreshAccessToken() {
    const refreshToken = this.settings.get('refreshToken');
    if (!refreshToken) throw new Error('No refreshToken stored — please log in again');

    const response = await axios.post(`${this.baseUrl}/users/refreshToken`, {
      refreshToken,
      nativeVersion: '2.6.3',
      webVersion: '2.6.3',
      t: Date.now(),
    }, { headers: this._baseHeaders() });

    const data = response.data;
    if (!data.accessToken) {
      throw new Error('Token refresh failed: no accessToken in response');
    }

    this.settings.set('accessToken', data.accessToken);
    this.log('[InnrApi] accessToken refreshed');
    return data.accessToken;
  }

  /**
   * Runs an authenticated request; on 401/expired-token, refreshes once and retries.
   * @param {Function} requestFn - () => axios promise, using current tokens
   */
  async _withRetry(requestFn) {
    try {
      return await requestFn();
    } catch (error) {
      const status = error.response?.status;
      this.log('[InnrApi] request failed:', {
        url: error.config?.url,
        status,
        data: error.response?.data,
      });
      if (status === 401 || status === 403) {
        this.log('[InnrApi] auth error, refreshing token and retrying once');
        await this.refreshAccessToken();
        return requestFn();
      }
      throw error;
    }
  }

  async getHouses() {
    return this._withRetry(async () => {
      const response = await axios.get(`${this.baseUrl}/houses?isDefault=true`, {
        headers: this._authHeaders(),
      });
      return response.data;
    });
  }

  async getDevices(houseId) {
    return this._withRetry(async () => {
      const response = await axios.get(`${this.baseUrl}/devices?houseId=${houseId}`, {
        headers: this._authHeaders(),
      });
      return response.data;
    });
  }

  /** All devices across all houses with deviceCount > 0. Also stores the first house's id for reuse (e.g. mqttConfig). */
  async getAllDevices() {
    const houses = await this.getHouses();
    let all = [];
    for (const house of houses) {
      if (house.deviceCount > 0) {
        const devices = await this.getDevices(house.id);
        all = all.concat(devices);
        if (!this.settings.get('houseId')) {
          this.settings.set('houseId', house.id);
        }
      }
    }
    return all;
  }

  /**
   * @param {string} houseId - required; sent as a header, not a query param (per capture)
   * @returns {Promise<{host:string,password:string,heartbeat:number,clientId:string}>}
   */
  async getMqttConfig(houseId) {
    if (!houseId) throw new Error('getMqttConfig requires a houseId');
    return this._withRetry(async () => {
      const response = await axios.get(`${this.baseUrl}/commons/mqttConfig?allowApp=`, {
        headers: this._authHeaders({ houseId }),
      });
      return response.data;
    });
  }

}

module.exports = InnrApi;