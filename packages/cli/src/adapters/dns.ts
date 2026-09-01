import { promises as dns } from 'node:dns';

/**
 * Hostname resolution seam.
 *
 * `doctor` enforces the deployed rule that a partner origin must not resolve to a private or
 * reserved address, and the mirror-image `--local` rule that a loopback rehearsal must not
 * resolve anywhere else. Both are decided from resolved addresses, so tests inject this to
 * exercise the rules without a network or a DNS server.
 */
export type HostResolver = (hostname: string) => Promise<string[]>;

export const resolveNodeHost: HostResolver = async (hostname) =>
  (await dns.lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

/**
 * A resolver whose answer changes between calls, for exercising DNS rebinding.
 *
 * A deterministic fake cannot catch a validate-then-connect gap, because both lookups agree.
 * This one hands out each answer in turn and repeats the last, so a caller that resolves twice
 * is observably connecting to something it did not validate.
 */
export function changingHostResolver(answers: string[][]): HostResolver {
  let call = 0;
  return async () => answers[Math.min(call++, answers.length - 1)];
}

/** A resolver that answers from a fixed table. Unknown names fail as they would in DNS. */
export function fixedHostResolver(table: Record<string, string[]>): HostResolver {
  return async (hostname) => {
    const addresses = table[hostname];
    if (addresses === undefined) {
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
    }
    return addresses;
  };
}
