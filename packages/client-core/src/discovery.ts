import { CsipDiscoveryError, ResourceClient } from './resource-client.js';
import { isCanonicalLfdi } from './identity.js';
import type {
  AssignedProgram,
  AssignmentSnapshot,
  DeviceAssignment,
  SessionStore,
} from './session-store.js';

export interface AssignmentDiscoveryOptions {
  resources: ResourceClient;
  store: SessionStore;
  maxResources?: number;
}

export class AssignmentDiscovery {
  readonly #resources: ResourceClient;
  readonly #store: SessionStore;
  readonly #maxResources: number;

  constructor(options: AssignmentDiscoveryOptions) {
    this.#resources = options.resources;
    this.#store = options.store;
    this.#maxResources = options.maxResources ?? 512;
    if (!Number.isSafeInteger(this.#maxResources) || this.#maxResources <= 0) {
      throw new CsipDiscoveryError('maxResources must be a positive safe integer');
    }
  }

  async reconcile(
    deviceCapabilityHref: string,
    knownLFDIs: ReadonlySet<string>,
    eligibleLFDIs: ReadonlySet<string> = knownLFDIs,
  ): Promise<AssignmentSnapshot> {
    try {
      const snapshot = await this.#discover(deviceCapabilityHref, knownLFDIs, eligibleLFDIs);
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
  ): Promise<AssignmentSnapshot> {
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
    const capability = await this.#resources.deviceCapability(deviceCapabilityHref);
    if (!capability.EndDeviceListLink) {
      throw new CsipDiscoveryError('DeviceCapability does not provide EndDeviceListLink');
    }
    const endDevices = await this.#resources.endDevices(capability.EndDeviceListLink);
    consume(endDevices.length);
    const seen = new Set<string>();
    for (const device of endDevices) {
      if (seen.has(device.lFDI)) throw new CsipDiscoveryError(`EndDeviceList contains duplicate LFDI ${device.lFDI}`);
      if (!knownLFDIs.has(device.lFDI)) throw new CsipDiscoveryError(`EndDeviceList contains unknown LFDI ${device.lFDI}`);
      seen.add(device.lFDI);
    }

    const devices: DeviceAssignment[] = [];
    for (const device of endDevices) {
      if (device.href) this.#resources.canonicalHref(device.href);
      const programs: AssignedProgram[] = [];
      if (eligibleLFDIs.has(device.lFDI) && device.FunctionSetAssignmentsListLink) {
        const assignments = await this.#resources.functionSetAssignments(device.FunctionSetAssignmentsListLink);
        consume(assignments.length);
        for (const assignment of assignments) {
          if (assignment.href) this.#resources.canonicalHref(assignment.href);
          if (!assignment.DERProgramListLink) {
            throw new CsipDiscoveryError(`FunctionSetAssignments ${assignment.mRID} has no DERProgramListLink`);
          }
          const assignedPrograms = await this.#resources.derPrograms(assignment.DERProgramListLink);
          consume(assignedPrograms.length);
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
      devices.push({
        lFDI: device.lFDI,
        ...(device.href ? { href: device.href } : {}),
        programs,
      });
    }
    return { valid: true, devices };
  }
}
