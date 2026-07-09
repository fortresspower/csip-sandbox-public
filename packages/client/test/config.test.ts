import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('defaults cadences and reads server URL from env', () => {
    const cfg = loadConfig({ CSIP_SERVER_URL: 'http://localhost:7001', CSIP_SUBSCRIPTION: 'model101.W,model802.SoC' });
    expect(cfg.serverUrl).toBe('http://localhost:7001');
    expect(cfg.controlPollSec).toBe(600);
    expect(cfg.telemetryPostSec).toBe(300);
    expect(cfg.subscription).toEqual(['model101.W', 'model802.SoC']);
  });
});
