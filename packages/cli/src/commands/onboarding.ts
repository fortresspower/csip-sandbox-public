import { resolve as resolvePath } from 'node:path';
import { flag, parseCommandArgs, stringOption } from '../args.js';
import type { Command, CommandContext } from '../command.js';
import { EXIT_CHECKS_FAILED, EXIT_OK, UsageError, type ExitCode } from '../errors.js';
import { EXIT_CODE_HELP, INTEGRATION_MODEL } from '../help.js';

const USAGE = 'onboarding [options]';

export const HANDOFF_SCHEMA = 'fortress-csip-partner-handoff/v1';

/**
 * The public handoff contract.
 *
 * This command explains and validates; it issues nothing. No real certificate is created, no
 * Fortress API is called, and no connection is activated — those happen through the agreed
 * secure channel between two organizations, not through a public CLI.
 */
export function onboardingCommand(): Command {
  return {
    name: 'onboarding',
    arguments: '[options]',
    summary: 'Show the real-connection handoff contract',
    help: () =>
      [
        `fortress-csip ${USAGE}`,
        '',
        'Explain what each side provides when a real Fortress connection is set up,',
        'and generate or validate the submission template.',
        '',
        'Options:',
        '  --json                 Print the contract as JSON',
        '  --template             Print a blank partner submission template',
        '  --validate PATH        Check a completed submission and report what is missing',
        '  --out PATH             Write --template or the contract to PATH',
        '',
        'This command issues nothing. It creates no certificate, calls no Fortress API,',
        'and activates no connection. Real certificate material and contact details are',
        'exchanged through the agreed secure channel, not through this tool.',
        '',
        ...EXIT_CODE_HELP,
      ].join('\n'),
    run: async (argv: string[], context: CommandContext): Promise<ExitCode> => {
      const { values } = parseCommandArgs('onboarding', argv, {
        json: { type: 'boolean' },
        template: { type: 'boolean' },
        validate: { type: 'string' },
        out: { type: 'string' },
      });
      const asJson = flag(values, 'json');
      const asTemplate = flag(values, 'template');
      const validatePath = stringOption(values, 'validate', 'onboarding');
      const outPath = stringOption(values, 'out', 'onboarding');
      const absolute = (path: string) => resolvePath(context.io.cwd, path);

      if (asTemplate && validatePath !== undefined) {
        throw new UsageError('--template and --validate cannot be combined', 'onboarding');
      }

      if (validatePath !== undefined) {
        return validateSubmission(context, absolute(validatePath));
      }

      const payload = asTemplate ? submissionTemplate() : contract();
      const serialized = `${JSON.stringify(payload, null, 2)}\n`;

      if (asJson || asTemplate) {
        context.io.out(serialized.trimEnd());
      } else {
        for (const line of renderContract()) context.io.out(line);
      }
      if (outPath !== undefined) {
        await context.io.writeFileAtomic(absolute(outPath), serialized);
        if (!asJson && !asTemplate) context.io.out(`Written to ${outPath}`);
      }
      return EXIT_OK;
    },
  };
}

function contract() {
  return {
    schema: 'fortress-csip-handoff-contract/v1',
    integrationModel: {
      client: 'Fortress',
      server: 'Partner',
      transport: 'HTTPS with mutual TLS on TCP 443, initiated by Fortress',
    },
    partnerProvides: [
      'a stable public HTTPS origin on TCP 443, backed by public DNS',
      'a server certificate from a CA in the standard public trust store',
      'a technical contact and an operations contact',
      'the requested fleet and cadence tier',
      'a completed conformance evidence artifact',
    ],
    fortressProvides: [
      'the public chain for one connection-specific client certificate',
      'the aggregator LFDI derived from that certificate leaf',
      'the SHA-256 fingerprint and expiry of that leaf',
      'a stable connection identifier',
      'a proposed preflight window',
    ],
    partnerThenDoes: [
      'install and trust the supplied Fortress client issuer',
      'allowlist the exact aggregator LFDI',
    ],
    neverExchanged: [
      'any private key',
      'a per-device roster or spreadsheet of EndDevice identities',
    ],
    enablementSequence: [
      'Fortress exercises authentication, discovery, enrollment, and telemetry without executing controls',
      'both sides review the evidence',
      'one bounded command rehearsal is performed',
      'broader enablement follows',
    ],
  };
}

function renderContract(): string[] {
  const model = contract();
  const bullets = (items: string[]) => items.map((item) => `  - ${item}`);
  return [
    'Fortress CSIP — connection handoff contract',
    '',
    ...INTEGRATION_MODEL,
    'Fortress initiates every request; you never call a Fortress endpoint.',
    '',
    'You provide:',
    ...bullets(model.partnerProvides),
    '',
    'Fortress provides:',
    ...bullets(model.fortressProvides),
    '',
    'You then:',
    ...bullets(model.partnerThenDoes),
    '',
    'Trusting the issuer and allowlisting the LFDI are both required. Either alone',
    'is not authorization.',
    '',
    'Never exchanged, in either direction:',
    ...bullets(model.neverExchanged),
    '',
    'Before commands are enabled:',
    ...model.enablementSequence.map((step, index) => `  ${index + 1}. ${step}`),
    '',
    'Generate your submission:',
    '  fortress-csip onboarding --template --out ./fortress-csip-handoff.json',
    '  fortress-csip onboarding --validate ./fortress-csip-handoff.json',
  ];
}

function submissionTemplate() {
  return {
    schema: HANDOFF_SCHEMA,
    origin: 'https://csip.partner.example',
    technicalContact: { name: '', email: '' },
    operationsContact: { name: '', email: '' },
    requestedFleetTier: { sites: 1000, standardTelemetrySeconds: 300 },
    evidenceFile: 'fortress-csip-evidence.json',
  };
}

/**
 * Check a completed submission.
 *
 * Deliberately shallow: it looks for the fields Fortress needs and for the mistakes that
 * waste a round trip — a placeholder left unfilled, an origin that is not HTTPS. It does not
 * contact anything.
 */
async function validateSubmission(context: CommandContext, path: string): Promise<ExitCode> {
  let parsed: Record<string, unknown>;
  try {
    const raw = await context.io.readFile(path);
    parsed = JSON.parse(Buffer.from(raw).toString('utf8')) as Record<string, unknown>;
  } catch (error) {
    context.io.err(`fortress-csip onboarding: could not read ${path} as JSON`);
    context.io.err(`  ${(error as Error).message}`);
    return EXIT_CHECKS_FAILED;
  }

  const problems: string[] = [];
  if (parsed.schema !== HANDOFF_SCHEMA) {
    problems.push(`schema must be "${HANDOFF_SCHEMA}"`);
  }

  const origin = typeof parsed.origin === 'string' ? parsed.origin : '';
  if (origin === '' || origin.includes('partner.example')) {
    problems.push('origin is still the placeholder — set your real public HTTPS origin');
  } else {
    try {
      const url = new URL(origin);
      if (url.protocol !== 'https:') problems.push('origin must use HTTPS');
      if (url.port !== '' && url.port !== '443') problems.push('origin must be reachable on TCP 443');
      if (url.username !== '' || url.password !== '') problems.push('origin must not carry URL credentials');
    } catch {
      problems.push('origin is not a valid URL');
    }
  }

  for (const key of ['technicalContact', 'operationsContact']) {
    const contact = parsed[key] as { name?: unknown; email?: unknown } | undefined;
    if (typeof contact?.name !== 'string' || contact.name.trim() === '') {
      problems.push(`${key}.name is empty`);
    }
    if (typeof contact?.email !== 'string' || !contact.email.includes('@')) {
      problems.push(`${key}.email is empty or not an address`);
    }
  }

  const tier = parsed.requestedFleetTier as { sites?: unknown; standardTelemetrySeconds?: unknown } | undefined;
  if (!Number.isSafeInteger(tier?.sites) || (tier?.sites as number) <= 0) {
    problems.push('requestedFleetTier.sites must be a positive whole number');
  }
  if (!Number.isSafeInteger(tier?.standardTelemetrySeconds) || (tier?.standardTelemetrySeconds as number) <= 0) {
    problems.push('requestedFleetTier.standardTelemetrySeconds must be a positive whole number of seconds');
  }

  if (typeof parsed.evidenceFile !== 'string' || parsed.evidenceFile.trim() === '') {
    problems.push('evidenceFile must name the artifact from `fortress-csip conformance`');
  }

  // A private key in a submission is the one mistake worth refusing loudly.
  const serialized = JSON.stringify(parsed);
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(serialized)) {
    problems.push('the submission contains private-key material — remove it and rotate that key');
  }

  if (problems.length === 0) {
    context.io.out(`${path} is a complete Fortress CSIP handoff submission.`);
    context.io.out('');
    context.io.out('Send it, with the evidence artifact it names, through the agreed secure channel.');
    return EXIT_OK;
  }

  context.io.out(`${path} is not ready to send:`);
  for (const problem of problems) context.io.out(`  - ${problem}`);
  return EXIT_CHECKS_FAILED;
}
