import type { DERProgram } from '@fortress-csip/protocol';

export interface AssignmentSnapshotV1 {
  siteId: string;
  snapshotVersion: string;
  asOf: string;
  programProjectionKeys: string[];
}

export interface AssignmentSourceV1 {
  getAssignmentSnapshot(siteId: string): Promise<AssignmentSnapshotV1>;
}

export interface EndDeviceIdentity {
  id: string;
  siteId: string;
  lFDI: string;
  sFDI: string;
  changedTime: number;
  fsaMRID: string;
}

export interface ProgramProjection {
  projectionKey: string;
  resourceId: string;
  mRID: string;
  primacy: number;
}

export class UnknownProgramProjectionError extends Error {
  constructor() {
    super('Fortress returned an unknown program projection key');
    this.name = 'UnknownProgramProjectionError';
  }
}

export class ProgramProjectionCatalog {
  private readonly byKey = new Map<string, ProgramProjection>();
  private readonly byResourceId = new Map<string, ProgramProjection>();

  constructor(programs: ProgramProjection[]) {
    for (const program of programs) {
      if (
        !program.projectionKey
        || !program.resourceId
        || !/^[0-9A-Fa-f]{32}$/.test(program.mRID)
        || !Number.isSafeInteger(program.primacy)
        || program.primacy < 0
        || this.byKey.has(program.projectionKey)
        || this.byResourceId.has(program.resourceId)
      ) {
        throw new Error('invalid or duplicate DERProgram projection');
      }
      this.byKey.set(program.projectionKey, { ...program });
      this.byResourceId.set(program.resourceId, { ...program });
    }
  }

  resolve(keys: string[]): DERProgram[] {
    const programs = keys.map((key) => {
      const program = this.byKey.get(key);
      if (program == null) throw new UnknownProgramProjectionError();
      return program;
    });
    const unique = new Map(programs.map(program => [program.resourceId, program]));
    return [...unique.values()]
      .sort((a, b) => a.resourceId.localeCompare(b.resourceId, 'en', { numeric: true }))
      .map(program => ({
        href: `/derp/${encodeURIComponent(program.resourceId)}`,
        mRID: program.mRID,
        primacy: program.primacy,
        DERControlListLink: {
          href: `/derp/${encodeURIComponent(program.resourceId)}/derc`,
        },
      }));
  }

  get(resourceId: string): DERProgram | undefined {
    const program = this.byResourceId.get(resourceId);
    if (program == null) return undefined;
    return {
      href: `/derp/${encodeURIComponent(program.resourceId)}`,
      mRID: program.mRID,
      primacy: program.primacy,
      DERControlListLink: {
        href: `/derp/${encodeURIComponent(program.resourceId)}/derc`,
      },
    };
  }
}

export class FixtureEnrollmentSourceV1 implements AssignmentSourceV1 {
  private readonly programsBySite = new Map<string, string[]>();
  private revision = 0;

  constructor(programsBySite: Record<string, string[]>) {
    for (const [siteId, keys] of Object.entries(programsBySite)) {
      this.programsBySite.set(siteId, [...keys]);
    }
  }

  setProgramProjectionKeys(siteId: string, keys: string[]): void {
    this.programsBySite.set(siteId, [...keys]);
    this.revision += 1;
  }

  async getAssignmentSnapshot(siteId: string): Promise<AssignmentSnapshotV1> {
    return {
      siteId,
      snapshotVersion: `fixture-v1-${this.revision}`,
      asOf: new Date(0).toISOString(),
      programProjectionKeys: [...(this.programsBySite.get(siteId) ?? [])],
    };
  }
}

export const DEFAULT_END_DEVICES: EndDeviceIdentity[] = [{
  id: '0',
  siteId: '1001',
  lFDI: '12a4a4b406ad102e7421019135ffa2805235a21c',
  sFDI: '050044792964',
  changedTime: 1514836800,
  fsaMRID: '00112233445566778899AABBCCDDEEFF',
}];

export const DEFAULT_PROGRAM_PROJECTIONS: ProgramProjection[] = [
  {
    projectionKey: 'fortress-program-1',
    resourceId: '0',
    mRID: 'AABBCCDDEEFF00112233445566778899',
    primacy: 0,
  },
  {
    projectionKey: 'fortress-program-2',
    resourceId: '1',
    mRID: 'BBCCDDEEFF00112233445566778899AA',
    primacy: 1,
  },
];

export const makeDefaultFixtureEnrollmentSource = (): FixtureEnrollmentSourceV1 => (
  new FixtureEnrollmentSourceV1({
    '1001': ['fortress-program-1', 'fortress-program-2'],
  })
);
