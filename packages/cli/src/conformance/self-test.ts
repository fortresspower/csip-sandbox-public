import { createServer, type Server } from 'node:http';
import { createCsipTransport, type CsipTransport } from '@fortress-csip/client-core';
import { makePartnerApp } from '@fortress-csip/example-server/partner-app';
import { MemoryPartnerPersistence } from '@fortress-csip/example-server/persistence/memory';
import type { Io } from '../io.js';
import { REHEARSAL_DURATION_SECONDS } from './runner.js';
import type { OperatorDriver, OperatorInstruction } from './types.js';

/**
 * The bundled production-shaped server the self-test runs against.
 *
 * `conformance --self-test` proves the harness itself: that the checks run end to end, that
 * the profile is satisfiable, and that a clean checkout can demonstrate all of it without a
 * Fortress service, a partner endpoint, or a certificate. Anything that fails here is a bug
 * in the toolkit, not in a partner's server — which is exactly what makes it worth running in
 * CI.
 */

const CONNECTION_ID = 'self-test';
const PROGRAM_ID = 'rehearsal';
/** Synthetic aggregator identity. The self-test terminates TLS nowhere, so this is a label. */
const AGGREGATOR_LFDI = 'cccccccccccccccccccccccccccccccccccccccc';
/** A second connection, used only to prove overlapping identifiers stay isolated. */
const OTHER_CONNECTION_ID = 'self-test-other';
const OTHER_AGGREGATOR_LFDI = 'dddddddddddddddddddddddddddddddddddddddd';
const OTHER_DEVICE_LFDI = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

export interface SelfTestFixture {
  transport: CsipTransport;
  driver: OperatorDriver;
  origin: string;
  close(): Promise<void>;
}

export async function startSelfTestFixture(io: Io): Promise<SelfTestFixture> {
  const persistence = new MemoryPartnerPersistence();
  const { app, domain } = makePartnerApp({
    persistence,
    // Loopback with no TLS: the self-test is about the protocol profile. Identity and
    // transport enforcement are proven separately by `demo --mtls` and `doctor`.
    resolveConnection: () => CONNECTION_ID,
    now: () => Math.floor(io.now().getTime() / 1000),
  });
  await domain.createConnection(CONNECTION_ID, AGGREGATOR_LFDI);
  await domain.createProgram(CONNECTION_ID, PROGRAM_ID, 'rehearsal-dispatch', 3);

  const server = createServer(app);
  const port = await listen(server);
  const origin = `http://localhost:${port}`;

  const transport = createCsipTransport({
    baseUrl: origin,
    environment: 'local-test',
    resolveDns: async () => ['127.0.0.1'],
  });

  /**
   * In the self-test the operator is the example server's own domain.
   *
   * This is allowed precisely because it is an in-repository fixture: it stands in for the
   * partner's operator tooling, and it is never a requirement placed on a real partner. The
   * checks are still made from what the CSIP connection shows.
   */
  const driver: OperatorDriver = {
    // Everything happens synchronously here, so the harness needs only a couple of polls.
    pollTimeoutMs: 5_000,
    pollIntervalMs: 50,
    async request(instruction: OperatorInstruction): Promise<void> {
      if (instruction.kind === 'assignment') {
        await domain.moveAssignment(CONNECTION_ID, PROGRAM_ID, instruction.targetLfdi);
        return;
      }
      if (instruction.kind === 'assignment-move') {
        await domain.moveAssignment(CONNECTION_ID, PROGRAM_ID, instruction.toLfdi);
        return;
      }
      await domain.publishControl({
        connectionId: CONNECTION_ID,
        programId: PROGRAM_ID,
        mRID: instruction.mRID,
        start: instruction.start,
        duration: instruction.durationSeconds ?? REHEARSAL_DURATION_SECONDS,
        opModFixedW: instruction.opModFixedW,
      });
    },

    // A second connection reusing the same program and control mRIDs. If connection scope
    // leaked, the first connection's graph would start showing the second one's devices or
    // controls — which is exactly what the check looks for.
    async seedOverlappingConnection(mRID: string): Promise<boolean> {
      await domain.createConnection(OTHER_CONNECTION_ID, OTHER_AGGREGATOR_LFDI);
      await domain.createProgram(OTHER_CONNECTION_ID, PROGRAM_ID, 'rehearsal-dispatch', 3);
      await domain.registerDevice(OTHER_CONNECTION_ID, OTHER_DEVICE_LFDI);
      await domain.moveAssignment(OTHER_CONNECTION_ID, PROGRAM_ID, OTHER_DEVICE_LFDI);
      await domain.publishControl({
        connectionId: OTHER_CONNECTION_ID,
        programId: PROGRAM_ID,
        mRID,
        start: Math.floor(io.now().getTime() / 1000),
        duration: REHEARSAL_DURATION_SECONDS,
        opModFixedW: 500,
      });
      return true;
    },
  };

  return {
    transport,
    driver,
    origin,
    close: async () => {
      transport.close?.();
      await new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}

function listen(server: Server): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address !== null ? address.port : 0);
    });
  });
}
