import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import type {
  AssignmentSnapshotV1,
  AssignmentSourceV1,
} from './enrollment-source.js';

interface AssignmentSnapshotRequestV1 {
  caller: {
    requestId: string;
    principalId: string;
    actor: string;
  };
  site: { siteId: string };
}

export interface AssignmentSnapshotRpcV1 {
  getAssignmentSnapshot(
    request: AssignmentSnapshotRequestV1,
    serviceToken: string,
    deadline: Date,
  ): Promise<unknown>;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined => (
  value != null && !Array.isArray(value) && typeof value === 'object'
    ? value as Record<string, unknown>
    : undefined
);

export function normalizeAssignmentSnapshotV1(
  value: unknown,
  expectedSiteId: string,
): AssignmentSnapshotV1 {
  const snapshot = asRecord(value);
  if (snapshot == null) throw new Error('Fortress assignment snapshot is invalid');
  const siteId = snapshot.siteId;
  const snapshotVersion = snapshot.snapshotVersion;
  const asOf = snapshot.asOf;
  const keys = snapshot.programProjectionKeys;
  if (
    typeof siteId !== 'string'
    || typeof snapshotVersion !== 'string'
    || snapshotVersion.length === 0
    || typeof asOf !== 'string'
    || Number.isNaN(Date.parse(asOf))
    || !Array.isArray(keys)
    || keys.some(key => typeof key !== 'string' || key.length === 0)
    || new Set(keys).size !== keys.length
  ) {
    throw new Error('Fortress assignment snapshot is invalid');
  }
  if (siteId !== expectedSiteId) {
    throw new Error('Fortress assignment snapshot returned a different site');
  }
  return {
    siteId,
    snapshotVersion,
    asOf,
    programProjectionKeys: [...keys] as string[],
  };
}

export class FortressEnrollmentSourceV1 implements AssignmentSourceV1 {
  constructor(
    private readonly rpc: AssignmentSnapshotRpcV1,
    private readonly options: {
      principalId: string;
      actor: string;
      serviceToken: string;
      deadlineMs?: number;
      requestId?: () => string;
    },
  ) {
    if (!options.principalId || !options.actor || !options.serviceToken) {
      throw new Error('Fortress enrollment service identity is incomplete');
    }
  }

  async getAssignmentSnapshot(siteId: string): Promise<AssignmentSnapshotV1> {
    const response = asRecord(await this.rpc.getAssignmentSnapshot(
      {
        caller: {
          requestId: (this.options.requestId ?? randomUUID)(),
          principalId: this.options.principalId,
          actor: this.options.actor,
        },
        site: { siteId },
      },
      this.options.serviceToken,
      new Date(Date.now() + (this.options.deadlineMs ?? 3_000)),
    ));
    return normalizeAssignmentSnapshotV1(response?.snapshot, siteId);
  }
}

type DynamicEnrollmentClient = grpc.Client & {
  getAssignmentSnapshot(
    request: AssignmentSnapshotRequestV1,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, response?: unknown) => void,
  ): grpc.ClientUnaryCall;
};

type DynamicEnrollmentClientConstructor = new (
  address: string,
  credentials: grpc.ChannelCredentials,
) => DynamicEnrollmentClient;

const PROTO_PATH = fileURLToPath(new URL(
  '../proto/vpp_enrollment_projection.proto',
  import.meta.url,
));

export function makeGrpcAssignmentSnapshotRpcV1(options: {
  address: string;
  credentials: grpc.ChannelCredentials;
}): AssignmentSnapshotRpcV1 {
  const definition = protoLoader.loadSync(PROTO_PATH, {
    defaults: true,
    enums: String,
    keepCase: false,
    longs: String,
    oneofs: true,
  });
  const loaded = grpc.loadPackageDefinition(definition) as unknown as {
    fortress: {
      manager: {
        vpp: {
          enrollment: {
            VppEnrollment: DynamicEnrollmentClientConstructor;
          };
        };
      };
    };
  };
  const Client = loaded.fortress.manager.vpp.enrollment.VppEnrollment;
  const client = new Client(options.address, options.credentials);
  return {
    getAssignmentSnapshot(request, serviceToken, deadline) {
      const metadata = new grpc.Metadata();
      metadata.set('authorization', `Bearer ${serviceToken}`);
      return new Promise((resolve, reject) => {
        client.getAssignmentSnapshot(
          request,
          metadata,
          { deadline },
          (error, response) => {
            if (error != null) reject(error);
            else if (response == null) reject(new Error('Fortress returned no assignment snapshot'));
            else resolve(response);
          },
        );
      });
    },
  };
}
