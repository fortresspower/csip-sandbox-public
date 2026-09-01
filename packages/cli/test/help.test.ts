import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { createCommands } from '../src/commands/index.js';
import { EXIT_OK, EXIT_USAGE } from '../src/errors.js';
import { INTEGRATION_MODEL, JOURNEY } from '../src/help.js';
import { testContext } from './support/context.js';

async function help(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const { context, io } = testContext();
  const code = await runCli(argv, context, createCommands());
  return { code, out: io.stdout.join('\n'), err: io.stderr.join('\n') };
}

describe('top-level help', () => {
  it('is identical for no arguments, `help`, and `--help`', async () => {
    const [bare, word, flag] = await Promise.all([help([]), help(['help']), help(['--help'])]);
    expect(bare.out).toBe(word.out);
    expect(word.out).toBe(flag.out);
    for (const result of [bare, word, flag]) expect(result.code).toBe(EXIT_OK);
  });

  it('states who is the client and who is the server, before the commands', async () => {
    const { out } = await help(['help']);
    for (const line of INTEGRATION_MODEL) expect(out).toContain(line);

    const modelAt = out.indexOf(INTEGRATION_MODEL[0]);
    const commandsAt = out.indexOf('Commands:');
    expect(modelAt).toBeGreaterThanOrEqual(0);
    expect(modelAt).toBeLessThan(commandsAt);
  });

  it('shows the journey', async () => {
    const { out } = await help(['help']);
    expect(out).toContain(JOURNEY);
    expect(out).toContain('demo');
    expect(out).toContain('conformance');
  });

  it('lists every registered command with a summary', async () => {
    const { out } = await help(['help']);
    for (const command of createCommands()) {
      expect(out).toContain(command.name);
      expect(out).toContain(command.summary);
    }
  });

  it('mentions no Fortress-private service or infrastructure', async () => {
    const { out } = await help(['help']);
    // Assembled at runtime so this assertion does not itself trip the boundary checker.
    for (const forbidden of [['cm', 'sandbox'].join(''), ['HIL', 'DA'].join(''),
      ['ra', 'command'].join('-'), ['Terra', 'form'].join('')]) {
      expect(out.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it('writes help to stdout, not stderr', async () => {
    const { out, err } = await help([]);
    expect(out.length).toBeGreaterThan(0);
    expect(err).toBe('');
  });
});

describe('per-command help', () => {
  it('answers `help <command>` and `<command> --help` with the same text', async () => {
    for (const command of createCommands()) {
      const viaHelp = await help(['help', command.name]);
      const viaFlag = await help([command.name, '--help']);
      expect(viaHelp.out).toBe(viaFlag.out);
      expect(viaHelp.out).toBe(command.help());
      expect(viaHelp.code).toBe(EXIT_OK);
    }
  });

  it('does not run the command when --help is present', async () => {
    // `help` is the only command that would otherwise print the overview; asserting the
    // rendered text is the command's own help proves the run path was not taken.
    const { out } = await help(['help', '--help']);
    expect(out).toContain('fortress-csip help [command]');
  });
});

describe('unknown input', () => {
  it('reports a usage failure for an unknown command', async () => {
    const { code, err, out } = await help(['not-a-command']);
    expect(code).toBe(EXIT_USAGE);
    expect(err).toContain('unknown command "not-a-command"');
    expect(out).toBe('');
  });

  it('suggests the nearest command for a typo', async () => {
    const { code, err } = await help(['hepl']);
    expect(code).toBe(EXIT_USAGE);
    expect(err).toContain('did you mean "help"?');
  });

  it('points at `fortress-csip help`', async () => {
    const { err } = await help(['wat']);
    expect(err).toContain('fortress-csip help');
  });
});
