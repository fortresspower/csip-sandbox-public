import { CsipDiscoveryError, ResourceClient, type EndDeviceFleetSnapshot } from './resource-client.js';
import { isCanonicalLfdi } from './identity.js';
import type {
  AssignedProgram,
  AssignmentSnapshot,
  DeviceAssignment,
  SessionStore,
} from './session-store.js';
import {
  DEFAULT_WORK_CONCURRENCY,
  mapConcurrent,
  throwIfAborted,
  validateWorkConcurrency,
  type CsipWorkOptions,
} from './concurrency.js';

export interface AssignmentDiscoveryOptions {
  resources: ResourceClient;
  store: SessionStore;
  maxResources?: number;
  /** Maximum simultaneous nested resource reads. Hard-capped at eight. */
  concurrency?: number;
}

export interface AssignmentReconcileOptions extends CsipWorkOptions {
  snapshot?: EndDeviceFleetSnapshot;
}

export const DEFAULT_MAX_ASSIGNMENT_RESOURCES = 500_000;

export class AssignmentDiscovery {
  readonly #resources: ResourceClient;
  readonly #store: SessionStore;
  readonly #maxResources: number;
  readonly #concurrency: number;

  constructor(options: AssignmentDiscoveryOptions) {
    this.#resources = options.resources;
    this.#store = options.store;
    this.#maxResources = options.maxResources ?? DEFAULT_MAX_ASSIGNMENT_RESOURCES;
    if (!Number.isSafeInteger(this.#maxResources) || this.#maxResources <= 0) {
      throw new CsipDiscoveryError('maxResources must be a positive safe integer');
    }
    try {
      this.#concurrency = validateWorkConcurrency(options.concurrency ?? DEFAULT_WORK_CONCURRENCY);
    } catch (error) {
      throw new CsipDiscoveryError((error as Error).message);
    }
  }

  async reconcile(
    deviceCapabilityHref: string,
    knownLFDIs: ReadonlySet<string>,
    eligibleLFDIs: ReadonlySet<string> = knownLFDIs,
    options: AssignmentReconcileOptions = {},
  ): Promise<AssignmentSnapshot> {
    try {
      const snapshot = await this.#discover(deviceCapabilityHref, knownLFDIs, eligibleLFDIs, options);
      await this.#store.saveAssignmentSnapshot(snapshot);
      return snapshot;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.#store.saveAssignmentSnapshot({ valid: false, devices: [], error: message });
      if (error instanceof CsipDiscoveryError) throw error;
      throw new CsipDiscoveryError(`assignment discovery failed closed: ${message}`);
    }
  }

  async #discover(
    deviceCapabilityHref: string,
    knownLFDIs: ReadonlySet<string>,
    eligibleLFDIs: ReadonlySet<string>,
    options: AssignmentReconcileOptions,
  ): Promise<AssignmentSnapshot> {
    throwIfAborted(options.signal);
    for (const lFDI of knownLFDIs) {
      if (!isCanonicalLfdi(lFDI)) throw new CsipDiscoveryError(`eligible LFDI is invalid: ${lFDI}`);
    }
    for (const lFDI of eligibleLFDIs) {
      if (!knownLFDIs.has(lFDI)) {
        throw new CsipDiscoveryError(`eligible LFDI is not a known registration: ${lFDI}`);
      }
    }
    let resourceCount = 0;
    const consume = (count: number): void => {
      resourceCount += count;
      if (resourceCount > this.#maxResources) {
        throw new CsipDiscoveryError(`resource graph exceeded the ${this.#maxResources}-resource limit`);
      }
    };

    consume(1);
    const fleet = options.snapshot
      ? this.#resources.requireEndDeviceFleet(deviceCapabilityHref, options.snapshot)
      : await this.#resources.endDeviceFleet(deviceCapabilityHref);
    const endDevices = fleet.endDevices;
    consume(endDevices.length);
    const seen = new Set<string>();
    for (const device of endDevices) {
      if (seen.has(device.lFDI)) throw new CsipDiscoveryError(`EndDeviceList contains duplicate LFDI ${device.lFDI}`);
      if (!knownLFDIs.has(device.lFDI)) throw new CsipDiscoveryError(`EndDeviceList contains unknown LFDI ${device.lFDI}`);
      seen.add(device.lFDI);
    }

    const assignmentReads = new Map<string, Promise<Awaited<ReturnType<ResourceClient['functionSetAssignments']>>>>();
    const programReads = new Map<string, Promise<Awaited<ReturnType<ResourceClient['derPrograms']>>>>();
    const readAssignments = (href: string): Promise<Awaited<ReturnType<ResourceClient['functionSetAssignments']>>> => {
      const canonical = this.#resources.canonicalHref(href);
      let pending = assignmentReads.get(canonical);
      if (!pending) {
        pending = this.#resources.functionSetAssignments(href).then((assignments) => {
          consume(assignments.length);
          return assignments;
        });
        assignmentReads.set(canonical, pending);
      }
      return pending;
    };
    const readPrograms = (href: string): Promise<Awaited<ReturnType<ResourceClient['derPrograms']>>> => {
      const canonical = this.#resources.canonicalHref(href);
      let pending = programReads.get(canonical);
      if (!pending) {
        pending = this.#resources.derPrograms(href).then((programs) => {
          consume(programs.length);
          return programs;
        });
        programReads.set(canonical, pending);
      }
      return pending;
    };

    const devices = await mapConcurrent(endDevices, this.#concurrency, async (device): Promise<DeviceAssignment> => {
      throwIfAborted(options.signal);
      if (device.href) this.#resources.canonicalHref(device.href);
      const programs: AssignedProgram[] = [];
      if (eligibleLFDIs.has(device.lFDI) && device.FunctionSetAssignmentsListLink) {
        const assignments = await readAssignments(device.FunctionSetAssignmentsListLink);
        for (const assignment of assignments) {
          throwIfAborted(options.signal);
          if (assignment.href) this.#resources.canonicalHref(assignment.href);
          if (!assignment.DERProgramListLink) {
            throw new CsipDiscoveryError(`FunctionSetAssignments ${assignment.mRID} has no DERProgramListLink`);
          }
          const assignedPrograms = await readPrograms(assignment.DERProgramListLink);
          for (const program of assignedPrograms) {
            if (program.href) this.#resources.canonicalHref(program.href);
            if (!program.DERControlListLink) {
              throw new CsipDiscoveryError(`DERProgram ${program.mRID} has no DERControlListLink`);
            }
            this.#resources.canonicalHref(program.DERControlListLink);
            programs.push({
              mRID: program.mRID,
              ...(program.href ? { href: program.href } : {}),
              primacy: program.primacy,
              controlListHref: program.DERControlListLink,
              functionSetAssignmentMrid: assignment.mRID,
              ...(assignment.href ? { functionSetAssignmentHref: assignment.href } : {}),
            });
          }
        }
      }
      return {
        lFDI: device.lFDI,
        ...(device.href ? { href: device.href } : {}),
        programs,
      };
    }, options.signal);
    return { valid: true, devices };
  }
}
