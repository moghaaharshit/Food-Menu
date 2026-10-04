/**
 * Behaviour tests for the order -> WhatsApp dispatch state machine.
 *
 * The source under test is EXTRACTED FROM index.html (not re-implemented), so
 * this verifies the code the browser actually runs.
 *
 * What must hold:
 *   1. A successful send marks the order 'ordered' + stamps waSentAt. That is
 *      what removes it from the admin panel (which only queries 'pending').
 *   2. A FAILED send must NOT change status -- the order stays visible in the
 *      admin panel until the alert actually goes out.
 *   3. Failures retry with capped exponential backoff.
 *   4. Concurrent calls for the same order never double-send.
 *
 *   npm run test:dispatch
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const lines = html.split('\n');

const start = lines.findIndex(l => l.includes('const WA_RETRY_BASE_MS'));
const end = lines.findIndex(l => l.includes('function WhatsAppSettings()'));
if (start === -1 || end === -1) { console.error('FAIL: dispatch block not found'); process.exitCode = 1; throw new Error('not found'); }
const source = lines.slice(start, end).join('\n');

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '\n        ' + extra : ''}`);
  if (!cond) failures++;
};

/** Build a fresh sandbox with mocked Firestore + WhatsApp transport. */
function makeEnv({ sendImpl }) {
  const updates = [];
  const deletes = [];
  const scheduled = [];      // retry timers that were scheduled

  const sandbox = {
    console: { warn() {}, log() {}, error() {} },
    setTimeout: (fn, ms) => { scheduled.push(ms); return scheduled.length; },
    firebase: {
      firestore: {
        FieldValue: { serverTimestamp: () => '<serverTimestamp>' },
        Timestamp: { fromDate: (d) => d },
      },
    },
    fbDb: {
      batch: () => ({ delete() {}, async commit() {} }),
      collection: () => ({
        doc: () => ({
          update: async (payload) => { updates.push(payload); },
          delete: async () => { deletes.push(1); },
        }),
        where: () => ({ get: async () => ({ empty: true, size: 0, forEach() {} }) }),
      }),
    },
    sendOrderToWhatsApp: sendImpl,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    source +
    '\n; globalThis.__d = {' +
    '  dispatchOrderToWhatsApp,' +
    '  waAttempts,' +
    '  setGap: (v) => { WA_SEND_GAP_MS = v; }' +
    '};',
    sandbox
  );
  // Collapse the inter-send gap to 0 so the queue never waits on a timer the
  // stub would never fire. Retry timers (>= 30s) are still recorded, never run.
  sandbox.__d.setGap(0);
  return { api: sandbox.__d, updates, deletes, scheduled };
}

/* ── 1. Success flips the order out of the admin queue ── */
{
  const { api, updates, scheduled } = makeEnv({ sendImpl: async () => ({ ok: true }) });
  await api.dispatchOrderToWhatsApp('ord1', { id: 'ord1', userName: 'Rahul' });

  check('success updates the order exactly once', updates.length === 1, `updates=${updates.length}`);
  const u = updates[0] || {};
  check("success sets status to 'ordered'", u.status === 'ordered', `status=${u.status}`);
  check('success stamps waSentAt', u.waSentAt === '<serverTimestamp>');
  check('success records the attempt count', u.waAttempts === 1, `waAttempts=${u.waAttempts}`);
  check('success schedules no retry', scheduled.length === 0, `scheduled=${JSON.stringify(scheduled)}`);
  check('attempt counter cleared after success', api.waAttempts.size === 0);
}

/* ── 2. Failure must NOT touch the order (it stays visible in admin) ── */
{
  const { api, updates, scheduled } = makeEnv({ sendImpl: async () => ({ ok: false, error: 'WhatsApp is not connected.' }) });
  await api.dispatchOrderToWhatsApp('ord2', { id: 'ord2' });

  check('failure performs no order update', updates.length === 0, `updates=${JSON.stringify(updates)}`);
  check('failure schedules a retry', scheduled.length === 1, `scheduled=${JSON.stringify(scheduled)}`);
  check('first retry waits 30s', scheduled[0] === 30000, `delay=${scheduled[0]}`);
}

/* ── 3. A throwing transport is treated as failure, not a crash ── */
{
  const { api, updates, scheduled } = makeEnv({ sendImpl: async () => { throw new Error('network down'); } });
  await api.dispatchOrderToWhatsApp('ord3', { id: 'ord3' });

  check('throwing transport does not update the order', updates.length === 0);
  check('throwing transport still schedules a retry', scheduled.length === 1);
}

/* ── 4. Backoff grows then caps at 5 minutes ── */
{
  const { api, scheduled } = makeEnv({ sendImpl: async () => ({ ok: false }) });
  const delays = [];
  for (let i = 0; i < 8; i++) {
    const before = scheduled.length;
    await api.dispatchOrderToWhatsApp('ord4', { id: 'ord4' });
    if (scheduled.length > before) delays.push(scheduled[scheduled.length - 1]);
  }
  const expected = [30000, 60000, 120000, 240000, 300000, 300000, 300000, 300000];
  check('backoff sequence is exponential then capped',
    JSON.stringify(delays) === JSON.stringify(expected),
    `got      ${JSON.stringify(delays)}\n        expected ${JSON.stringify(expected)}`);
}

/* ── 5. Concurrent calls for one order do not double-send ── */
{
  let sends = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const { api, updates } = makeEnv({
    sendImpl: async () => { sends++; await gate; return { ok: true }; },
  });

  const a = api.dispatchOrderToWhatsApp('ord5', { id: 'ord5' });
  const b = api.dispatchOrderToWhatsApp('ord5', { id: 'ord5' });
  const c = api.dispatchOrderToWhatsApp('ord5', { id: 'ord5' });

  // The queue defers the first send through a microtask, so let it start.
  await new Promise(r => setImmediate(r));
  check('concurrent calls collapse into a single send (in-flight)', sends === 1, `sends=${sends}`);

  release();
  await Promise.all([a, b, c]);
  check('exactly one send in total', sends === 1, `sends=${sends}`);
  check('exactly one order update after settling', updates.length === 1, `updates=${updates.length}`);
}

/* ── 6. A backlog is serialised, not blasted concurrently ── */
{
  let live = 0;
  let peak = 0;
  const { api, updates } = makeEnv({
    sendImpl: async () => {
      live++;
      peak = Math.max(peak, live);
      await new Promise(r => setImmediate(r));
      live--;
      return { ok: true };
    },
  });

  await Promise.all([
    api.dispatchOrderToWhatsApp('b1', { id: 'b1' }),
    api.dispatchOrderToWhatsApp('b2', { id: 'b2' }),
    api.dispatchOrderToWhatsApp('b3', { id: 'b3' }),
    api.dispatchOrderToWhatsApp('b4', { id: 'b4' }),
  ]);

  check('backlog never sends two at once', peak === 1, `peak concurrency=${peak}`);
  check('every backlog order still gets marked ordered', updates.length === 4, `updates=${updates.length}`);
  check('all backlog orders marked as ordered', updates.every(u => u.status === 'ordered'));
}

console.log(`\n${failures === 0 ? 'ALL DISPATCH CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exitCode = failures === 0 ? 0 : 1;