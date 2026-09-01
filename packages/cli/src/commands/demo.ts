import { resolve as resolvePath } from 'node:path';
import { flag, parseCommandArgs, stringOption } from '../args.js';
import type { Command, CommandContext } from '../command.js';
import { createDockerDriver } from '../demo/docker.js';
import {
  CLIENT_STATUS_URL,
  CONSOLE_URL,
  SWAGGER_URL,
  verifyDemoLoop,
} from '../demo/verify.js';
import { EXIT_CHECKS_FAILED, EXIT_OK, EXIT_OPERATIONAL, UsageError, type ExitCode } from '../errors.js';
import { EXIT_CODE_HELP } from '../help.js';
import { onTermination } from '../signals.js';

/**
 * Run the local sandbox: an IEEE 2030.5 server and a Fortress-shaped client, closing the loop
 * on one machine with no certificates, no partner endpoint, and no Fortress account.
 *
 * This is the first success in the journey. It wraps the existing compose topology rather than
 * reimplementing it, so what a partner sees here is the same stack the repository has always
 * shipped.
 */
export function demoCommand(): Command {
  return {
    name: 'demo',
    arguments: '[options]',
    summary: 'Run the local closed-loop sandbox',
    help: () =>
      [
        'fortress-csip demo [options]',
        '',
        'Start the local sandbox: an example IEEE 2030.5 server and a mocked Fortress',
        'client, dispatching and reporting against each other on your machine.',
        '',
        'Options:',
        '  --detach               Start in the background and return immediately',
        '  --verify               Prove dispatch moves telemetry, then tear down',
        '  --mtls                 Run the production-shaped mutual-TLS rehearsal instead',
        '',
        'Without options the stack runs in the foreground; Ctrl-C stops and removes it.',
        `Docker's own exit status is returned unchanged.`,
        '',
        'URLs once running:',
        `  Partner console: ${CONSOLE_URL}`,
        `  Swagger UI:      ${SWAGGER_URL}`,
        `  Client status:   ${CLIENT_STATUS_URL}`,
        '',
        'With --mtls the rehearsal stands up the production-shaped partner app behind a',
        'Node TLS terminator, proves the four client-identity outcomes Fortress will meet,',
        'and removes every generated key on exit. No Docker and no real certificates.',
        '',
        'Equivalent without the toolkit:',
        '  docker compose up --build',
        '',
        ...EXIT_CODE_HELP,
      ].join('\n'),
    run: async (argv: string[], context: CommandContext): Promise<ExitCode> => {
      const { values } = parseCommandArgs('demo', argv, {
        detach: { type: 'boolean' },
        verify: { type: 'boolean' },
        mtls: { type: 'boolean' },
        json: { type: 'boolean' },
        out: { type: 'string' },
      });

      const detach = flag(values, 'detach');
      const verify = flag(values, 'verify');
      const mtls = flag(values, 'mtls');

      if (detach && verify) {
        throw new UsageError(
          '--detach and --verify are mutually exclusive: verification tears the stack down',
          'demo',
        );
      }

      if (mtls && detach) {
        throw new UsageError(
          '--mtls runs a self-contained rehearsal and cannot be detached',
          'demo',
        );
      }
      if (mtls) {
        // The rehearsal needs no Docker at all: it stands up the production-shaped partner
        // app in this process behind a Node TLS terminator. Loaded on demand so that the
        // express server it composes stays off the startup path of every other command.
        const { runMtlsRehearsal } = await import('../mtls/rehearsal.js');
        return runMtlsRehearsal(context, {
          json: flag(values, 'json'),
          out: stringOption(values, 'out', 'demo'),
          resolvePath: (path) => resolvePath(context.io.cwd, path),
        });
      }

      const docker = createDockerDriver(context.runProcess, context.repositoryRoot);
      await docker.preflight();

      if (!verify && !detach) return runAttached(docker, context);
      return runDetached(docker, context, { verify });
    },
  };
}

async function runAttached(
  docker: ReturnType<typeof createDockerDriver>,
  context: CommandContext,
): Promise<ExitCode> {
  printUrls(context);
  context.io.out('');
  context.io.out('Starting (Ctrl-C to stop and remove the stack)...');

  // Compose in the foreground already stops its own containers on Ctrl-C, but it leaves them
  // defined; `down` is what returns the machine to the state we found it in.
  const release = onTermination(async () => {
    await docker.down();
  });
  try {
    const code = await docker.upAttached();
    await docker.down();
    return code === 0 ? EXIT_OK : EXIT_OPERATIONAL;
  } finally {
    release();
  }
}

async function runDetached(
  docker: ReturnType<typeof createDockerDriver>,
  context: CommandContext,
  options: { verify: boolean },
): Promise<ExitCode> {
  if (!options.verify) {
    await docker.up();
    printUrls(context);
    context.io.out('');
    context.io.out('Running in the background. Stop it with `docker compose down`.');
    return EXIT_OK;
  }

  // Verification owns the stack completely: it must tear down on success, on assertion
  // failure, on an unexpected throw, and on Ctrl-C. Each of those paths is covered below.
  const release = onTermination(async () => {
    context.io.err('');
    context.io.err('Interrupted — tearing down the demo stack.');
    await docker.down();
  });
  try {
    await docker.up();
    const outcome = await verifyDemoLoop({
      fetch: context.fetch,
      io: context.io,
      sleep: context.sleep,
    });
    context.io.out('');
    if (outcome.passed) {
      context.io.out(`PASS  ${outcome.detail}`);
      return EXIT_OK;
    }
    context.io.out(`FAIL  ${outcome.detail}`);
    return EXIT_CHECKS_FAILED;
  } finally {
    release();
    await docker.down();
  }
}

function printUrls(context: CommandContext): void {
  context.io.out(`Partner console: ${CONSOLE_URL}`);
  context.io.out(`Swagger UI:      ${SWAGGER_URL}`);
  context.io.out(`Client status:   ${CLIENT_STATUS_URL}`);
}
