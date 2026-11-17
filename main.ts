// Entry point of the forge: this file owns the harness lifecycle, while
// app.ts and the modules behind it own the GitHub surface being scored.
//
// The lifecycle, in the order this process lives it:
//
//   1. MAKEFUN_ENV_URL names the contest env's origin. A trial always sets
//      it; with no env there is nothing to register with, so a missing or
//      empty value ends the process at once with exit code 1.
//   2. createApp() builds the forge server and listen(0) binds it: port 0
//      asks the kernel for a free ephemeral port. Port 8080 is never an
//      option here — the env itself listens there.
//   3. The bound port is announced to the env with a POST to /register
//      carrying {"port": N}. The env pairs that port with the address the
//      request arrived from and dials the pair from then on.
//   4. GET /done is polled until its body reads {"done": true}. The env
//      answers at once ({"done": false} while its suite still runs), so
//      this is a poll on a backoff, not a held-open request, and the
//      process never exits before the env declares the trial over.
//   5. The server closes and the process exits 0, leaving the env to write
//      the export the scorer reads.

import { createApp } from './app.ts';

/** The env's origin, normalised by dropping any trailing slashes. */
const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

if (envUrl === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set, so there is no env to register with\n');
  process.exit(1);
}

/** A single register or poll request may take at most this long. */
const REQUEST_DEADLINE_MS = 30_000;
/** Retry waits double from the first value and never pass the second. */
const FIRST_RETRY_WAIT_MS = 250;
const LONGEST_RETRY_WAIT_MS = 2_000;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The wait before retry number `attempt` (counted from 0): capped doubling. */
function retryWaitMs(attempt: number): number {
  const grown = FIRST_RETRY_WAIT_MS * 2 ** Math.min(attempt, 8);
  return Math.min(LONGEST_RETRY_WAIT_MS, grown);
}

/**
 * Announce the port the server bound, retrying until the env takes it.
 *
 * A 200 means the env recorded us; a 409 means an earlier register already
 * won, which is just as settled and also ends the loop. A 400 or a 405 is
 * the env rejecting the request itself — a contract error on our side — so
 * it is fatal and carries the env's answer in its message. Everything else
 * (a refused connection while the env is still starting, a timeout, an
 * unexpected status) is treated as "not yet" and retried on the backoff.
 */
async function announcePort(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_DEADLINE_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
      // Any other status is retried below; drain the body first so the
      // keep-alive connection is free for the next attempt.
      await res.text().catch(() => '');
    } catch (err) {
      const fatal = err instanceof Error && err.message.startsWith('register answered HTTP ');
      if (fatal) throw err;
    }
    await wait(retryWaitMs(attempt));
  }
}

/**
 * Poll the env until it reports the trial over. Only a 200 whose JSON body
 * carries done: true ends the wait; a not-yet body, an unreadable answer
 * and a failed request all count the same — not done — and are retried.
 */
async function waitForEnvDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${envUrl}/done`, {
        signal: AbortSignal.timeout(REQUEST_DEADLINE_MS),
      });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: poll again.
    }
    await wait(retryWaitMs(attempt));
  }
}

/** Bind the forge, announce it, and hold the process open until done. */
async function runEntry(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the forge server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] forge listening on port ${bound.port}\n`);

  await announcePort(bound.port);
  process.stdout.write('[entry] registered with the env; waiting for it to finish\n');

  await waitForEnvDone();
  server.close();
  process.stdout.write('[entry] env reports done; the forge exits\n');
}

try {
  await runEntry();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
