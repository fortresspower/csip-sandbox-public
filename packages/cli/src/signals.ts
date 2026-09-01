/**
 * Run a cleanup action when the process is asked to stop.
 *
 * Two commands create things that must not outlive them: `demo --verify` leaves Docker
 * containers running, and the mTLS rehearsal writes private keys to a temporary directory.
 * Both must be cleaned up on Ctrl-C, not only on the normal and error paths.
 *
 * The handler is registered once and removed by the returned release function, so a long
 * session that runs several commands does not accumulate listeners. Cleanup is awaited before
 * the process exits, and re-entry is guarded: a second Ctrl-C while cleanup is in flight must
 * not start a second teardown.
 */

const SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

/** Exit code convention for a process terminated by a signal. */
const SIGNAL_EXIT_BASE = 128;

export type Release = () => void;

export function onTermination(
  cleanup: () => Promise<void>,
  process_: NodeJS.Process = process,
): Release {
  let running = false;

  const handler = (signal: NodeJS.Signals) => {
    if (running) return;
    running = true;
    void cleanup()
      .catch(() => {
        // A failed teardown must not replace the signal as the reason we are exiting.
      })
      .finally(() => {
        release();
        process_.exit(SIGNAL_EXIT_BASE + signalNumber(signal));
      });
  };

  const release: Release = () => {
    for (const signal of SIGNALS) process_.removeListener(signal, handler);
  };

  for (const signal of SIGNALS) process_.on(signal, handler);
  return release;
}

function signalNumber(signal: NodeJS.Signals): number {
  return signal === 'SIGINT' ? 2 : 15;
}
