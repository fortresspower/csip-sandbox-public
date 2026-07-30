import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { describe, expect, it } from 'vitest';
import {
  FortressEnrollmentSourceV1,
  makeGrpcAssignmentSnapshotRpcV1,
  normalizeAssignmentSnapshotV1,
  type AssignmentSnapshotRpcV1,
} from '../src/fortress-enrollment-client.js';

describe('Fortress enrollment assignment contract v1', () => {
  it('accepts the producer-owned assignment snapshot fixture without translation drift', async () => {
    const path = fileURLToPath(new URL(
      './fixtures/assignment-snapshot-v1.json',
      import.meta.url,
    ));
    const fixture = JSON.parse(await readFile(path, 'utf8')) as unknown;

    expect(normalizeAssignmentSnapshotV1(fixture, '1001')).toEqual({
      siteId: '1001',
      snapshotVersion: 'd3d63aa32d023816ea626ae5556a7aa98b97ab3b12f86a612ac3e9447ad0cf25',
      asOf: '2026-07-30T16:00:00.000Z',
      programProjectionKeys: ['fortress-program-1', 'fortress-program-2'],
    });
  });

  it('sends the site and service caller context through the pinned RPC boundary', async () => {
    const calls: Array<{ request: unknown; token: string; deadline: Date }> = [];
    const rpc: AssignmentSnapshotRpcV1 = {
      async getAssignmentSnapshot(request, serviceToken, deadline) {
        calls.push({ request, token: serviceToken, deadline });
        return {
          snapshot: {
            siteId: '1001',
            snapshotVersion: 'version-1',
            asOf: '2026-07-30T16:00:00.000Z',
            programProjectionKeys: ['fortress-program-1'],
          },
        };
      },
    };
    const source = new FortressEnrollmentSourceV1(rpc, {
      principalId: 'csip-sandbox',
      actor: 'csip-sandbox',
      serviceToken: 'secret-token',
      deadlineMs: 2_000,
      requestId: () => 'request-1',
    });

    await expect(source.getAssignmentSnapshot('1001')).resolves.toMatchObject({
      siteId: '1001',
      programProjectionKeys: ['fortress-program-1'],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].request).toEqual({
      caller: {
        requestId: 'request-1',
        principalId: 'csip-sandbox',
        actor: 'csip-sandbox',
      },
      site: { siteId: '1001' },
    });
    expect(calls[0].token).toBe('secret-token');
    expect(calls[0].deadline.getTime()).toBeGreaterThan(Date.now());
  });

  it('rejects an incomplete or cross-site snapshot', () => {
    expect(() => normalizeAssignmentSnapshotV1({
      siteId: '1002',
      snapshotVersion: 'version-1',
      asOf: '2026-07-30T16:00:00.000Z',
      programProjectionKeys: [],
    }, '1001')).toThrow(/different site/);
    expect(() => normalizeAssignmentSnapshotV1({
      siteId: '1001',
      snapshotVersion: '',
      asOf: 'not-a-time',
      programProjectionKeys: [],
    }, '1001')).toThrow(/invalid/);
  });

  it('reads the pinned v1 contract over gRPC with authenticated service metadata', async () => {
    const protoPath = fileURLToPath(new URL(
      '../proto/vpp_enrollment_projection.proto',
      import.meta.url,
    ));
    const loaded = grpc.loadPackageDefinition(protoLoader.loadSync(protoPath, {
      defaults: true,
      enums: String,
      keepCase: false,
      longs: String,
      oneofs: true,
    })) as grpc.GrpcObject;
    const fortress = loaded.fortress as grpc.GrpcObject;
    const manager = fortress.manager as grpc.GrpcObject;
    const vpp = manager.vpp as grpc.GrpcObject;
    const enrollment = vpp.enrollment as grpc.GrpcObject;
    const Service = enrollment.VppEnrollment as grpc.ServiceClientConstructor;
    const observed: Array<{ token: unknown[]; siteId: string }> = [];
    const server = new grpc.Server();
    server.addService(Service.service, {
      getAssignmentSnapshot(
        call: grpc.ServerUnaryCall<{ site?: { siteId?: string } }, unknown>,
        callback: grpc.sendUnaryData<unknown>,
      ) {
        observed.push({
          token: call.metadata.get('authorization'),
          siteId: call.request.site?.siteId ?? '',
        });
        callback(null, {
          snapshot: {
            siteId: '1001',
            snapshotVersion: 'wire-version-1',
            asOf: '2026-07-30T16:00:00.000Z',
            programProjectionKeys: ['fortress-program-1'],
          },
        });
      },
    });
    const port = await new Promise<number>((resolve, reject) => {
      server.bindAsync(
        '127.0.0.1:0',
        grpc.ServerCredentials.createInsecure(),
        (error, selectedPort) => {
          if (error != null) reject(error);
          else resolve(selectedPort);
        },
      );
    });
    const source = new FortressEnrollmentSourceV1(
      makeGrpcAssignmentSnapshotRpcV1({
        address: `127.0.0.1:${port}`,
        credentials: grpc.credentials.createInsecure(),
      }),
      {
        principalId: 'csip-sandbox',
        actor: 'csip-sandbox',
        serviceToken: 'wire-secret',
        requestId: () => 'wire-request',
      },
    );

    try {
      await expect(source.getAssignmentSnapshot('1001')).resolves.toMatchObject({
        snapshotVersion: 'wire-version-1',
        programProjectionKeys: ['fortress-program-1'],
      });
      expect(observed).toEqual([{
        token: ['Bearer wire-secret'],
        siteId: '1001',
      }]);
    } finally {
      await new Promise<void>((resolve) => server.tryShutdown(() => resolve()));
    }
  });
});
