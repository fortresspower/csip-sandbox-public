#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { PartnerDomain } from '../packages/example-server/src/partner-domain.js';
import { DynamoPartnerPersistence } from '../packages/example-server/src/persistence/dynamodb.js';

type Output = (value: unknown) => void;

export async function runAdminCommand(domain: PartnerDomain, argv: string[], output: Output = console.log): Promise<void> {
  const [resource, action, ...rest] = argv;
  const flags = parseFlags(rest);
  if (resource === 'connection' && action === 'create') {
    const connection = await domain.createConnection(required(flags, 'connection'), required(flags, 'aggregator-lfdi'));
    output({ connectionId: connection.connectionId, authorized: true });
    return;
  }
  if (resource === 'connection' && action === 'rotate') {
    const connection = await domain.rotateConnectionIdentity(
      required(flags, 'connection'),
      required(flags, 'aggregator-lfdi'),
    );
    output({ connectionId: connection.connectionId, authorized: true, rotated: true });
    return;
  }
  if (resource === 'connection' && action === 'revoke') {
    const connectionId = required(flags, 'connection');
    await domain.revokeConnectionIdentity(connectionId, required(flags, 'aggregator-lfdi'));
    output({ connectionId, revoked: true });
    return;
  }
  if (resource === 'program' && action === 'create') {
    const program = await domain.createProgram(
      required(flags, 'connection'),
      required(flags, 'program'),
      required(flags, 'mrid'),
      integer(flags.primacy ?? '0', 'primacy'),
    );
    output({ programId: program.id, mRID: program.mRID, token: program.token, primacy: program.primacy });
    return;
  }
  if (resource === 'device' && action === 'list') {
    const devices = await domain.devices(required(flags, 'connection'));
    output(devices.map((device) => ({
      token: device.token,
      href: `/sep2/r/${device.token}/device`,
      assignedProgramIds: device.assignedProgramIds,
    })));
    return;
  }
  if (resource === 'assignment' && action === 'move') {
    const connectionId = required(flags, 'connection');
    const token = required(flags, 'device-token');
    const device = await domain.deviceByToken(connectionId, token);
    if (!device) throw new Error(`device token ${token} does not exist on connection ${connectionId}`);
    const programId = required(flags, 'program');
    await domain.moveAssignment(connectionId, programId, device.lFDI);
    output({ connectionId, programId, deviceToken: token, assigned: true });
    return;
  }
  if (resource === 'event' && action === 'publish') {
    rejectUnsupportedModes(flags);
    const result = await domain.publishEventCommand({
      connectionId: required(flags, 'connection'),
      requestId: required(flags, 'request'),
      eventId: required(flags, 'event'),
      targetLfdi: required(flags, 'target'),
      start: integer(flags.start ?? String(Math.floor(Date.now() / 1_000)), 'start'),
      duration: integer(flags.duration ?? '300', 'duration'),
      opModFixedW: number(required(flags, 'fixed-w'), 'fixed-w'),
    });
    output(result);
    return;
  }
  if (resource === 'event' && action === 'cancel') {
    const result = await domain.cancelEventCommand({
      connectionId: required(flags, 'connection'),
      requestId: required(flags, 'request'),
      eventId: required(flags, 'event'),
    });
    output(result);
    return;
  }
  if (resource === 'control' && action === 'publish') {
    rejectUnsupportedModes(flags);
    const now = Math.floor(Date.now() / 1_000);
    const control = await domain.publishControl({
      connectionId: required(flags, 'connection'),
      programId: required(flags, 'program'),
      mRID: required(flags, 'mrid'),
      start: integer(flags.start ?? String(now), 'start'),
      duration: integer(flags.duration ?? '300', 'duration'),
      opModFixedW: number(required(flags, 'fixed-w'), 'fixed-w'),
    });
    output({ connectionId: control.connectionId, programId: control.programId, mRID: control.mRID, start: control.start, duration: control.duration });
    return;
  }
  throw new Error(usage());
}

async function main(): Promise<void> {
  const tableName = process.env.CSIP_DYNAMODB_TABLE;
  if (!tableName) throw new Error('CSIP_DYNAMODB_TABLE is required');
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  const domain = new PartnerDomain({ persistence: new DynamoPartnerPersistence({ client, tableName }) });
  await runAdminCommand(domain, process.argv.slice(2), (value) => console.log(JSON.stringify(value, null, 2)));
}

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith('--') || value === undefined || value.startsWith('--')) throw new Error(`invalid option near ${flag ?? '(end)'}\n${usage()}`);
    const name = flag.slice(2);
    if (flags[name] !== undefined) throw new Error(`option --${name} was supplied more than once`);
    flags[name] = value;
  }
  return flags;
}

function rejectUnsupportedModes(flags: Record<string, string>): void {
  if (flags.connect !== undefined || flags['max-w'] !== undefined) {
    throw new Error('initial interoperability profile supports only --fixed-w');
  }
}

function required(flags: Record<string, string>, name: string): string {
  const value = flags[name];
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function number(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`--${name} must be finite`);
  return parsed;
}

function integer(value: string, name: string): number {
  const parsed = number(value, name);
  if (!Number.isSafeInteger(parsed)) throw new Error(`--${name} must be a safe integer`);
  return parsed;
}

function usage(): string {
  return [
    'Usage:',
    '  server-admin connection create --connection ID --aggregator-lfdi HEX',
    '  server-admin connection rotate --connection ID --aggregator-lfdi HEX',
    '  server-admin connection revoke --connection ID --aggregator-lfdi HEX',
    '  server-admin program create --connection ID --program ID --mrid MRID [--primacy N]',
    '  server-admin device list --connection ID',
    '  server-admin assignment move --connection ID --program ID --device-token TOKEN',
    '  server-admin control publish --connection ID --program ID --mrid MRID [--start EPOCH] [--duration 1..900] --fixed-w -5000..5000',
    '  server-admin event publish --connection ID --request ID --event ID --target LFDI [--start EPOCH] [--duration 1..900] --fixed-w -5000..5000',
    '  server-admin event cancel --connection ID --request ID --event ID',
  ].join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
