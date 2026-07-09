export interface ClientConfig {
  serverUrl: string;
  controlPollSec: number;
  telemetryPostSec: number;
  subscription: string[];          // catalog fortressPoint ids this partner receives
  inspectPort: number;
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ClientConfig {
  return {
    serverUrl: env.CSIP_SERVER_URL ?? 'http://localhost:7001',
    controlPollSec: Number(env.CSIP_CONTROL_POLL_SEC ?? 600),
    telemetryPostSec: Number(env.CSIP_TELEMETRY_POST_SEC ?? 300),
    subscription: (env.CSIP_SUBSCRIPTION ?? 'model101.W,model101.VAr,model101.Hz,model101.PhVphA,model802.SoC')
      .split(',').map((s) => s.trim()).filter(Boolean),
    inspectPort: Number(env.CSIP_INSPECT_PORT ?? 7100),
  };
}
