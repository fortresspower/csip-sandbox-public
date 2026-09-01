import { resolve } from 'node:path';
import { flag, parseCommandArgs, requirePositionals } from '../args.js';
import type { Command, CommandContext } from '../command.js';
import { daysUntil, loadCertificateIdentity } from '../certificate.js';
import { EXIT_OK, type ExitCode } from '../errors.js';

const USAGE = 'lfdi <certificate.pem>';

/**
 * Compute the aggregator LFDI of a client certificate.
 *
 * The partner needs this value to allowlist the Fortress client identity, and needs to be able
 * to recompute it themselves rather than trusting a value pasted into an email. Everything
 * printed is derivable from the public certificate.
 */
export function lfdiCommand(): Command {
  return {
    name: 'lfdi',
    arguments: '<certificate.pem>',
    summary: 'Compute an aggregator LFDI from a certificate',
    help: () =>
      [
        `fortress-csip ${USAGE}`,
        '',
        'Print the aggregator LFDI, expiry, and SHA-256 fingerprint of a client',
        'certificate. Allowlist the LFDI in your server to authorize that identity.',
        '',
        'Options:',
        '  --value-only           Print only the LFDI, for use in a script',
        '',
        'The argument is the certificate — the public file. Passing a private key is',
        'rejected. Nothing about the key is read, and no PEM body is printed.',
        '',
        'Examples:',
        '  fortress-csip lfdi ./fortress-client.pem',
        '  ALLOWED=$(fortress-csip lfdi ./fortress-client.pem --value-only)',
      ].join('\n'),
    run: async (argv: string[], context: CommandContext): Promise<ExitCode> => {
      const { values, positionals } = parseCommandArgs('lfdi', argv, {
        'value-only': { type: 'boolean' },
      });
      const [path] = requirePositionals(positionals, 1, 'lfdi', USAGE);

      const identity = await loadCertificateIdentity(
        resolve(context.io.cwd, path),
        context.io.readFile,
      );

      if (flag(values, 'value-only')) {
        context.io.out(identity.aggregatorLfdi);
        return EXIT_OK;
      }

      context.io.out(`Aggregator LFDI: ${identity.aggregatorLfdi}`);
      context.io.out(`Expires:         ${identity.notAfter.toISOString()}`);
      context.io.out(`SHA-256:         ${identity.fingerprintSha256}`);
      if (identity.subjectCommonName !== undefined) {
        context.io.out(`Subject CN:      ${identity.subjectCommonName}`);
      }

      const remaining = daysUntil(identity.notAfter, context.io.now());
      if (remaining < 0) {
        context.io.out('');
        context.io.out(`This certificate expired ${-remaining} day(s) ago.`);
      } else if (remaining <= 30) {
        context.io.out('');
        context.io.out(`This certificate expires in ${remaining} day(s). Plan a rotation.`);
      }
      return EXIT_OK;
    },
  };
}
