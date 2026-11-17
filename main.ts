// Entry point: the harness lifecycle.
//
// The env starts this program with MAKEFUN_ENV_URL pointing at itself.
// My job here is only plumbing: start the forge HTTP server on whatever
// port the kernel hands out, tell the env where it landed, then stay
// alive until the env reports the trial is over. All of the behaviour
// being scored lives behind createApp() in app.ts.

import { createApp } from './app.ts';

const envBase = (process.env.MAKEFUN_ENV_URL || '').replace(/\/+$/, '');

if (envBase.length === 0) {
  console.error('MAKEFUN_ENV_URL is missing; nowhere to register');
  process.exit(1);
}

const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

// Backoff between attempts at talking to the env: 200ms, doubling, 2s cap.
function backoff(failures: number): number {
  return Math.min(2000, 200 * 2 ** Math.min(failures, 6));
}

// One env call with a hard timeout; resolves null on any transport error.
async function callEnv(path: string, init?: RequestInit): Promise<Response | null> {
  try {
    return await fetch(envBase + path, { ...init, signal: AbortSignal.timeout(30000) });
  } catch {
    return null;
  }
}

// Announce the port. The env accepts the first registration only: a 409
// means somebody else got there first and is not an error for us. A 400
// or 405 means the request itself is malformed, so give up loudly.
async function announce(port: number): Promise<void> {
  let failures = 0;
  for (;;) {
    const res = await callEnv('/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port }),
    });
    if (res !== null && (res.status === 200 || res.status === 409)) return;
    if (res !== null && (res.status === 400 || res.status === 405)) {
      throw new Error('env refused the registration: HTTP ' + res.status);
    }
    failures += 1;
    await pause(backoff(failures));
  }
}

// Poll until the env's /done answers {"done": true}. Anything else —
// a false, a non-200, a timeout — just means "not yet".
async function untilDone(): Promise<void> {
  let failures = 0;
  for (;;) {
    const res = await callEnv('/done');
    if (res !== null && res.ok) {
      const payload: any = await res.json().catch(() => null);
      if (payload !== null && payload.done === true) return;
    }
    failures += 1;
    await pause(backoff(failures));
  }
}

const server = createApp();
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve());
});
const bound = server.address();
if (bound === null || typeof bound !== 'object') {
  console.error('server did not bind a TCP port');
  process.exit(1);
}
console.log('forge listening on port ' + bound.port);

try {
  await announce(bound.port);
  await untilDone();
} finally {
  server.close();
}
console.log('env signalled done; exiting');
process.exit(0);
