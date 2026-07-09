export interface SiteFixture { lFDI: string; nameplateW: number; capacityWh: number; initialSoC: number; }
export interface Snapshot { lFDI: string; realPowerW: number; reactivePowerVar: number; voltageV: number; frequencyHz: number; soc: number; connected: boolean; }

export class SyntheticGenerator {
  private soc: number;
  private setpointW = 0;       // signed: + charge, - discharge
  private maxLimitW: number;
  private connected = true;
  private t = 0;
  constructor(private readonly fx: SiteFixture) {
    this.soc = fx.initialSoC;
    this.maxLimitW = fx.nameplateW;
  }
  setDischargeSetpoint(watts: number) { this.setpointW = -Math.abs(watts); }
  setChargeSetpoint(watts: number) { this.setpointW = Math.abs(watts); }
  setMaxLimitW(watts: number) { this.maxLimitW = Math.max(0, watts); }
  setConnected(on: boolean) { this.connected = on; }

  /** Advance the simulation by dt seconds. */
  step(dtSeconds: number) {
    this.t += dtSeconds;
    if (!this.connected) return;
    const powerW = this.currentPowerW();
    const deltaWh = (powerW * dtSeconds) / 3600;            // + charge adds energy
    const deltaSoC = (deltaWh / this.fx.capacityWh) * 100;
    this.soc = Math.min(100, Math.max(0, this.soc + deltaSoC));
  }
  private currentPowerW(): number {
    if (!this.connected) return 0;
    const desired = this.setpointW;
    return Math.max(-this.maxLimitW, Math.min(this.maxLimitW, desired));
  }
  snapshot(): Snapshot {
    const p = this.currentPowerW();
    const jitter = Math.sin(this.t / 600);                  // deterministic, time-based
    return {
      lFDI: this.fx.lFDI,
      realPowerW: this.connected ? p : 0,
      reactivePowerVar: this.connected ? Math.round(p * 0.05) : 0,
      voltageV: 240 + jitter,
      frequencyHz: 60 + jitter * 0.02,
      soc: Math.round(this.soc * 10) / 10,
      connected: this.connected,
    };
  }
}
