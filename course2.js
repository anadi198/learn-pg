/* Postgres Lab — curriculum, part 2 (modules 6–10 + two-session scenarios). */
(() => {
'use strict';
const { S, QUIZ, SIM, INTERVIEW, JOB, WARN, LAB, TABLE, lit, DROP_EXTRA, seqOn, sorts, idxUsed, sims } = window.PGLAB_H;
const modules = window.PGLAB_COURSE.modules;
// run one statement outside any transaction; true on success, else the error message
const Engine_exec = async (t, sql) => { try { await t.q(sql, 10); return true; } catch (e) { return e.message; } };

/* ─────────────── two-session scenarios (replays of real Postgres behavior) ─────────────── */
Object.assign(sims, {
  'mvcc-readers': { setup: 'UPDATE products SET price_cents = 1500 WHERE id = 1;', title: 'A reader during an uncommitted update', intro: 'Session A updates a price but hasn’t committed yet. Session B reads the same row.',
    steps: [
      { s: 'A', sql: 'BEGIN;', out: 'BEGIN' },
      { s: 'A', sql: 'UPDATE products SET price_cents = 999 WHERE id = 1;', out: 'UPDATE 1', note: 'A has written a <b>new tuple version</b> (xmin = A’s transaction) and stamped the old one with xmax = A. Nothing is committed yet.' },
      { s: 'B', sql: 'SELECT price_cents FROM products WHERE id = 1;', out: ' price_cents\n-------------\n        1500', note: 'B doesn’t wait and doesn’t see 999. Its snapshot treats A as in progress, so the old version is the visible one. <b>Readers don’t block writers, and writers don’t block readers.</b>' },
      { s: 'A', sql: 'COMMIT;', out: 'COMMIT' },
      { s: 'B', sql: 'SELECT price_cents FROM products WHERE id = 1;', out: ' price_cents\n-------------\n         999', note: 'A new statement takes a new snapshot (READ COMMITTED), so B now sees the new version. The old one is dead and waits for VACUUM.' },
    ], moral: 'MVCC lets reads and writes proceed concurrently by keeping several versions of each row. The price is dead tuples that VACUUM must remove.' },
  'rc-nonrepeatable': { setup: 'UPDATE products SET stock = 40 WHERE id = 7;', title: 'READ COMMITTED: the same query, two answers', intro: 'The default isolation level. Every <em>statement</em> gets a fresh snapshot.',
    steps: [
      { s: 'A', sql: 'BEGIN;', out: 'BEGIN' },
      { s: 'A', sql: 'SELECT stock FROM products WHERE id = 7;', out: ' stock\n-------\n    40' },
      { s: 'B', sql: 'UPDATE products SET stock = 39 WHERE id = 7;', out: 'UPDATE 1', note: 'B runs in autocommit mode, so its change commits immediately.' },
      { s: 'A', sql: 'SELECT stock FROM products WHERE id = 7;', out: ' stock\n-------\n    39', note: 'Same transaction, same query, different answer. That’s a <b>non-repeatable read</b>. It’s fine for most OLTP code, and a trap for reports that read the same data twice and expect the numbers to add up.' },
      { s: 'A', sql: 'COMMIT;', out: 'COMMIT' },
    ], moral: 'Under READ COMMITTED, only single statements are consistent. A multi-statement report can mix different moments in time.' },
  'rr-snapshot': { setup: 'UPDATE products SET stock = 40 WHERE id = 7;', title: 'REPEATABLE READ: one snapshot, and a conflict', intro: 'Now A asks for REPEATABLE READ. Its snapshot is taken at its first query and kept for the whole transaction.',
    steps: [
      { s: 'A', sql: 'BEGIN ISOLATION LEVEL REPEATABLE READ;', out: 'BEGIN' },
      { s: 'A', sql: 'SELECT stock FROM products WHERE id = 7;', out: ' stock\n-------\n    40', note: 'The snapshot is taken <b>now</b>, at the first statement — not at BEGIN.' },
      { s: 'B', sql: 'UPDATE products SET stock = 39 WHERE id = 7;', out: 'UPDATE 1' },
      { s: 'A', sql: 'SELECT stock FROM products WHERE id = 7;', out: ' stock\n-------\n    40', note: 'A keeps seeing its snapshot. Reports get a consistent picture.' },
      { s: 'A', sql: 'UPDATE products SET stock = stock - 1 WHERE id = 7;', out: 'ERROR:  could not serialize access due to concurrent update', cls: 'err', note: 'A tries to modify a row that changed after its snapshot. Postgres refuses rather than silently overwriting B’s work.' },
      { s: 'A', sql: 'ROLLBACK;', out: 'ROLLBACK', note: 'The application must <b>retry the whole transaction</b> (SQLSTATE 40001). That retry loop is the price of the stronger level.' },
    ], moral: 'REPEATABLE READ gives a stable snapshot and turns lost updates into errors that you retry.' },
  'lost-update': { setup: 'UPDATE products SET stock = 10 WHERE id = 7;', title: 'Lost update: read-modify-write in app code', intro: 'Two requests buy the same item. Each reads the stock, subtracts 1 in application code, and writes the result back. Default READ COMMITTED.',
    steps: [
      { s: 'A', sql: 'BEGIN;', out: 'BEGIN' },
      { s: 'A', sql: 'SELECT stock FROM products WHERE id = 7;', out: ' stock\n-------\n    10' },
      { s: 'B', sql: 'BEGIN;', out: 'BEGIN' },
      { s: 'B', sql: 'SELECT stock FROM products WHERE id = 7;', out: ' stock\n-------\n    10', note: 'Both requests saw 10, and both compute 9 in application code.' },
      { s: 'A', sql: 'UPDATE products SET stock = 9 WHERE id = 7;', out: 'UPDATE 1', note: 'A now holds a row lock on product 7.' },
      { s: 'B', sql: 'UPDATE products SET stock = 9 WHERE id = 7;', out: '… waiting for A’s row lock', cls: 'wait' },
      { s: 'A', sql: 'COMMIT;', out: 'COMMIT' },
      { s: 'B', sql: '', out: 'UPDATE 1', note: 'B’s update goes through — and writes 9 again. Two units sold, stock went down by one. <b>A lost update.</b> No error, no warning.' },
      { s: 'B', sql: 'COMMIT;', out: 'COMMIT' },
    ], moral: 'Never compute a new value in the application from a value you read earlier, unless you locked it (FOR UPDATE), check a version, or use a stricter isolation level. Better: let the database do the arithmetic.' },
  'atomic-update': { setup: 'UPDATE products SET stock = 10 WHERE id = 7;', title: 'The fix: let the database do the arithmetic', intro: 'Same race, but each request runs one atomic conditional UPDATE.',
    steps: [
      { s: 'A', sql: 'BEGIN;', out: 'BEGIN' },
      { s: 'A', sql: 'UPDATE products SET stock = stock - 1\nWHERE id = 7 AND stock >= 1 RETURNING stock;', out: ' stock\n-------\n     9' },
      { s: 'B', sql: 'UPDATE products SET stock = stock - 1\nWHERE id = 7 AND stock >= 1 RETURNING stock;', out: '… waiting for A’s row lock', cls: 'wait' },
      { s: 'A', sql: 'COMMIT;', out: 'COMMIT' },
      { s: 'B', sql: '', out: ' stock\n-------\n     8', note: 'After the lock is released, READ COMMITTED <b>re-reads the latest committed version</b> of the row, re-checks the WHERE clause, and applies <code>stock - 1</code> to it. That re-check is called EvalPlanQual. Result: 8. And if stock had hit 0, B would update 0 rows — “sold out”, no negative stock.' },
    ], moral: 'Atomic, conditional UPDATEs with RETURNING are the simplest correct way to handle counters and stock under concurrency.' },
  'write-skew': { setup: "CREATE TABLE IF NOT EXISTS doctors (name text PRIMARY KEY, on_call boolean NOT NULL); DELETE FROM doctors; INSERT INTO doctors VALUES ('alice', true), ('bob', true);", title: 'Write skew under REPEATABLE READ', intro: 'Rule: at least one doctor must stay on call. Alice and Bob are both on call, and each wants to go off.',
    steps: [
      { s: 'A', sql: 'BEGIN ISOLATION LEVEL REPEATABLE READ;', out: 'BEGIN' },
      { s: 'A', sql: 'SELECT count(*) FROM doctors WHERE on_call;', out: ' count\n-------\n     2', note: 'Alice checks: 2 on call, so she can leave.' },
      { s: 'B', sql: 'BEGIN ISOLATION LEVEL REPEATABLE READ;', out: 'BEGIN' },
      { s: 'B', sql: 'SELECT count(*) FROM doctors WHERE on_call;', out: ' count\n-------\n     2', note: 'Bob checks at the same time and sees the same 2.' },
      { s: 'A', sql: "UPDATE doctors SET on_call = false WHERE name = 'alice';", out: 'UPDATE 1' },
      { s: 'B', sql: "UPDATE doctors SET on_call = false WHERE name = 'bob';", out: 'UPDATE 1', note: 'They update <em>different rows</em>, so there’s no row conflict for REPEATABLE READ to detect.' },
      { s: 'A', sql: 'COMMIT;', out: 'COMMIT' },
      { s: 'B', sql: 'COMMIT;', out: 'COMMIT', note: 'Both commit. <b>Zero doctors are on call.</b> Each transaction was correct on its own snapshot, but together they broke the rule. That’s write skew.' },
    ], moral: 'Snapshot isolation doesn’t stop anomalies where each transaction reads what the other one writes. Use SERIALIZABLE, lock the rows you read (<code>SELECT … FOR UPDATE</code>), or turn the rule into a constraint.' },
  'serializable': { setup: "CREATE TABLE IF NOT EXISTS doctors (name text PRIMARY KEY, on_call boolean NOT NULL); DELETE FROM doctors; INSERT INTO doctors VALUES ('alice', true), ('bob', true);", title: 'SERIALIZABLE catches the write skew', intro: 'The same story, run at SERIALIZABLE. Postgres uses Serializable Snapshot Isolation (SSI): it tracks read/write dependencies between transactions.',
    steps: [
      { s: 'A', sql: 'BEGIN ISOLATION LEVEL SERIALIZABLE;', out: 'BEGIN' },
      { s: 'A', sql: 'SELECT count(*) FROM doctors WHERE on_call;', out: ' count\n-------\n     2' },
      { s: 'B', sql: 'BEGIN ISOLATION LEVEL SERIALIZABLE;', out: 'BEGIN' },
      { s: 'B', sql: 'SELECT count(*) FROM doctors WHERE on_call;', out: ' count\n-------\n     2' },
      { s: 'A', sql: "UPDATE doctors SET on_call = false WHERE name = 'alice';", out: 'UPDATE 1' },
      { s: 'B', sql: "UPDATE doctors SET on_call = false WHERE name = 'bob';", out: 'UPDATE 1' },
      { s: 'A', sql: 'COMMIT;', out: 'COMMIT' },
      { s: 'B', sql: 'COMMIT;', out: 'ERROR:  could not serialize access due to read/write dependencies among transactions\nDETAIL:  Reason code: Canceled on identification as a pivot, during commit attempt.\nHINT:  The transaction might succeed if retried.', cls: 'err', note: 'SSI noticed that the two transactions can’t be placed in <em>any</em> serial order that explains both results, and aborted one. On retry, Bob sees 1 doctor on call and doesn’t leave.' },
    ], moral: 'SERIALIZABLE gives you “as if one at a time” correctness in exchange for retries (SQLSTATE 40001). The app must retry the whole transaction, not just the last statement.' },
  'skip-locked': { setup: "DROP TABLE IF EXISTS demo_jobs; CREATE TABLE demo_jobs (id int PRIMARY KEY, status text NOT NULL DEFAULT 'queued', run_at timestamptz NOT NULL); INSERT INTO demo_jobs SELECT g, 'queued', now() - (10 - g) * interval '1 minute' FROM generate_series(1, 8) g;", cleanup: 'DROP TABLE IF EXISTS demo_jobs;', title: 'Queue workers with SKIP LOCKED', intro: 'Two workers pull jobs from the same table.',
    steps: [
      { s: 'A', sql: 'BEGIN;', out: 'BEGIN' },
      { s: 'A', sql: "SELECT id FROM demo_jobs WHERE status = 'queued'\nORDER BY run_at LIMIT 2 FOR UPDATE SKIP LOCKED;", out: ' id\n----\n  1\n  2', note: 'Worker A locks jobs 1 and 2.' },
      { s: 'B', sql: 'BEGIN;', out: 'BEGIN' },
      { s: 'B', sql: "SELECT id FROM demo_jobs WHERE status = 'queued'\nORDER BY run_at LIMIT 2 FOR UPDATE SKIP LOCKED;", out: ' id\n----\n  3\n  4', note: 'B <b>skips</b> the locked rows and gets the next two immediately. Without SKIP LOCKED, B would block on job 1 until A finished, and your workers would run one at a time.' },
      { s: 'A', sql: "UPDATE demo_jobs SET status = 'done' WHERE id IN (1, 2);\nCOMMIT;", out: 'UPDATE 2\nCOMMIT' },
      { s: 'B', sql: "UPDATE demo_jobs SET status = 'done' WHERE id IN (3, 4);\nCOMMIT;", out: 'UPDATE 2\nCOMMIT' },
    ], moral: 'FOR UPDATE SKIP LOCKED turns a table into a concurrent work queue. If a worker crashes, its transaction aborts and its jobs are automatically unlocked.' },
  'deadlock': { setup: 'CREATE TABLE IF NOT EXISTS accounts (id int PRIMARY KEY, balance int NOT NULL); DELETE FROM accounts; INSERT INTO accounts VALUES (1, 1000), (2, 1000);', title: 'A deadlock, and how Postgres breaks it', intro: 'Two transfers touch the same two accounts in opposite order.',
    steps: [
      { s: 'A', sql: 'BEGIN;', out: 'BEGIN' },
      { s: 'A', sql: 'UPDATE accounts SET balance = balance - 100 WHERE id = 1;', out: 'UPDATE 1', note: 'A locks account 1.' },
      { s: 'B', sql: 'BEGIN;', out: 'BEGIN' },
      { s: 'B', sql: 'UPDATE accounts SET balance = balance - 50 WHERE id = 2;', out: 'UPDATE 1', note: 'B locks account 2.' },
      { s: 'A', sql: 'UPDATE accounts SET balance = balance + 100 WHERE id = 2;', out: '… waiting for B', cls: 'wait' },
      { s: 'B', sql: 'UPDATE accounts SET balance = balance + 50 WHERE id = 1;', out: 'ERROR:  deadlock detected\nDETAIL:  Process 202 waits for ShareLock on transaction 901; blocked by process 101.\nProcess 101 waits for ShareLock on transaction 902; blocked by process 202.', cls: 'err', note: 'Each waits for the other. After <code>deadlock_timeout</code> (1 s) of waiting, a backend checks for a cycle, and the one that finds it aborts itself as the victim (SQLSTATE 40P01). In a live run, whichever session has waited 1 s <em>after</em> the cycle formed is the one that fails.' },
      { s: 'A', sql: '', out: 'UPDATE 1', note: 'B’s locks are released, so A proceeds.' },
      { s: 'A', sql: 'COMMIT;', out: 'COMMIT' },
      { s: 'B', sql: 'ROLLBACK;', out: 'ROLLBACK' },
    ], moral: 'Acquire locks in a consistent order (e.g. always the lower account id first, or <code>SELECT … ORDER BY id FOR UPDATE</code>), keep transactions short, and retry on 40P01.' },
  'ddl-queue': { setup: 'ALTER TABLE orders DROP COLUMN IF EXISTS note, DROP COLUMN IF EXISTS note2;', cleanup: 'ALTER TABLE orders DROP COLUMN IF EXISTS note, DROP COLUMN IF EXISTS note2;', title: 'The migration that took the site down', a: 'analytics', b: 'deploy', c: 'web app', intro: 'A harmless-looking <code>ALTER TABLE</code> meets an old open transaction.',
    steps: [
      { s: 'A', sql: 'BEGIN;\nSELECT count(*) FROM orders;', out: ' count\n--------\n 400000', note: 'An analyst’s session ran a query and left the transaction open. It holds an ACCESS SHARE lock on orders until it ends.' },
      { s: 'B', sql: 'ALTER TABLE orders ADD COLUMN note text;', out: '… waiting for AccessExclusiveLock', cls: 'wait', note: 'Adding a nullable column is instant — <em>once it gets its lock</em>. ACCESS EXCLUSIVE conflicts with everything, so it queues behind A.' },
      { s: 'C', sql: 'SELECT * FROM orders WHERE id = 42;', out: '… waiting', cls: 'wait', note: '<b>This is the outage.</b> Lock requests queue in order, and this plain SELECT conflicts with B’s <em>pending</em> exclusive request, so it waits behind B. So does every other query on orders. Connection pools fill up. Pages time out.' },
      { s: 'A', sql: 'COMMIT;', out: 'COMMIT' },
      { s: 'B', sql: '', out: 'ALTER TABLE' },
      { s: 'C', sql: '', out: '(1 row)', note: 'Everything drains within milliseconds. The ALTER itself was instant — the outage came entirely from waiting.' },
      { s: 'A', sql: 'BEGIN;\nSELECT count(*) FROM orders;', out: ' count\n--------\n 400000', note: 'The analyst opens another long transaction. The deploy tries again, the safe way this time.' },
      { s: 'B', sql: "SET lock_timeout = '2s';\nALTER TABLE orders ADD COLUMN note2 text;", out: 'ERROR:  canceling statement due to lock timeout', cls: 'err', note: 'With a <code>lock_timeout</code>, the migration gives up after 2 s instead of queueing, and the web app never notices. Retry it later with backoff, and find whoever is holding the old transaction.' },
      { s: 'A', sql: 'COMMIT;', out: 'COMMIT' },
    ], moral: 'Every migration should SET lock_timeout, and long-idle transactions should be killed (idle_in_transaction_session_timeout).' },
});

/* ═══════════════════════ MODULE 6 — Transactions & concurrency ═══════════════════════ */
modules.push({ title: 'Transactions & concurrency', localBest: true, lessons: [
{
  id: 'isolation', title: 'Transactions and isolation levels', minutes: 20,
  lede: 'Isolation levels are a contract about which anomalies you might see when transactions overlap. Postgres implements them with snapshots, which makes its behavior different from textbook lock-based descriptions.',
  body: `
<p>Without <code>BEGIN</code>, every statement is its own transaction (autocommit). Inside <code>BEGIN … COMMIT</code>, statements share one atomic unit. What each statement can <em>see</em> depends on the isolation level:</p>
${TABLE(['Level', 'Snapshot taken', 'You might see', 'Postgres notes'], [
  ['READ UNCOMMITTED', '—', '—', 'Accepted, but behaves exactly like READ COMMITTED. Postgres never shows uncommitted data (no dirty reads).'],
  ['<b>READ COMMITTED</b> (default)', 'At the start of <em>each statement</em>', 'Non-repeatable reads, phantoms, lost updates in read-modify-write code', 'A blocked UPDATE re-checks the newest row version after waiting (EvalPlanQual).'],
  ['REPEATABLE READ', 'At the first statement, kept for the whole transaction', 'Write skew', 'Snapshot isolation. Updating a row changed after your snapshot → error 40001, so retry.'],
  ['SERIALIZABLE', 'Like REPEATABLE READ, plus dependency tracking', 'Nothing — results match <em>some</em> serial order', 'SSI: may abort with 40001 at any statement or at COMMIT. Retry the whole transaction.'],
])}
<p>MySQL/InnoDB defaults to REPEATABLE READ and uses gap locks. Postgres defaults to READ COMMITTED and uses pure snapshots. Interviewers love that contrast.</p>
<h2>Play the scenarios</h2>
<p>This lab has one connection, so the scenarios below replay two real psql sessions step by step. Pick one from the menu, then step through it. The last module shows how to run them live.</p>
${SIM('rc-nonrepeatable', 'rr-snapshot', 'write-skew', 'serializable')}
<h2>Transaction mechanics in one session</h2>
<p><code>now()</code> is fixed at the start of the transaction. <code>clock_timestamp()</code> keeps moving:</p>
${S(`BEGIN;
SELECT now(), clock_timestamp();
SELECT pg_sleep(0.5);
SELECT now(), clock_timestamp();
COMMIT;`)}
<p>After an error, a transaction is <em>aborted</em>: every later statement fails until you ROLLBACK. Watch the prompt change to <code>postgres=!#</code>.</p>
${S(`BEGIN;
SELECT 1/0;
SELECT 'this will not run';
ROLLBACK;`)}
<p>A <code>SAVEPOINT</code> lets you roll back part of a transaction and keep going. That’s how drivers implement “try this insert; if it fails, carry on”.</p>
${S(`BEGIN;
SAVEPOINT before_risky;
SELECT 1/0;
ROLLBACK TO SAVEPOINT before_risky;
SELECT 'still alive' AS status;
COMMIT;`)}
${JOB(`<ul><li><strong>Keep transactions short.</strong> Locks are held until the end, and an open transaction stops VACUUM from cleaning up anywhere in the database.</li><li>Never wait on the network or a user while a transaction is open. <code>idle in transaction</code> connections are a warning sign; set <code>idle_in_transaction_session_timeout</code>.</li><li>If you use REPEATABLE READ or SERIALIZABLE, build a retry loop for SQLSTATE 40001 (and 40P01, deadlock) with jittered backoff.</li></ul>`)}
${QUIZ('q-rc', 'Under READ COMMITTED, can two identical SELECTs in the same transaction return different results?', ['Yes — each statement takes a new snapshot', 'No — the transaction pins one snapshot', 'Only if the table has no primary key'], 0, 'Each statement snapshots at its own start, so commits in between become visible. REPEATABLE READ pins one snapshot for the whole transaction.')}
${QUIZ('q-skew', 'Which Postgres isolation level prevents write skew (the on-call doctors problem)?', ['READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE'], 2, 'Only SERIALIZABLE (SSI) detects the read→write dependency cycle. At lower levels you prevent it with explicit locks (<code>SELECT … FOR UPDATE</code> on the rows you check) or with a constraint.')}
${INTERVIEW(`<p>“Explain the isolation levels” — give each level’s anomaly with a concrete example: stock updates for lost update, the report that doesn’t add up for non-repeatable read, the doctors for write skew. Name Postgres’s default, and say what the application has to do at the stricter levels: <em>retry</em>.</p>`)}
`,
  exercises: [
    { id: 'm6-savepoint', title: 'Recover inside a transaction with a savepoint',
      check: { type: 'probe', verify: async (t) => {
        const emails = `('first@lab.test', 'second@lab.test')`;
        t.need(/savepoint/i.test(t.user) && /rollback\s+to/i.test(t.user), 'Use a SAVEPOINT and ROLLBACK TO SAVEPOINT.');
        await t.q(`DELETE FROM customers WHERE email IN ${emails}`);
        const log = await t.runScript(t.user);
        const open = await t.inTxNow(); if (open) await t.q('ROLLBACK');
        const got = await t.rows(`SELECT email, count(*) FROM customers WHERE email IN ${emails} GROUP BY email ORDER BY 1`);
        await t.q(`DELETE FROM customers WHERE email IN ${emails}`);
        t.need(!open, 'Your script left the transaction open. End it with COMMIT.');
        t.need(log.some((x) => !x.ok && /duplicate|unique/i.test(x.error)), 'Your script should include the failing duplicate insert, so the savepoint has something to recover from.');
        t.need(got.length === 2 && got.every((r) => String(r[1]) === '1'), `After your script, expected exactly one first@lab.test and one second@lab.test. Found: ${got.map((r) => r.join(' × ')).join(', ') || 'none'}. Did an error abort the whole transaction?`);
        return 'The duplicate failed, the savepoint rescued the transaction, and both customers committed. (The checker then removed them.)';
      } },
      prompt: `<p>Write one transaction script that:</p><ol><li>inserts a customer with email <code>first@lab.test</code>,</li><li>sets a savepoint,</li><li>tries to insert <em>another</em> customer with the same email (this will fail with a unique violation),</li><li>rolls back to the savepoint,</li><li>inserts <code>second@lab.test</code>,</li><li>commits.</li></ol><p>Required columns: <code>email, full_name, country, city, signup_at</code>. The checker runs your script statement by statement, the way psql does, and then cleans up.</p>`,
      hint: '<p><code>BEGIN; INSERT …; SAVEPOINT s; INSERT … (duplicate); ROLLBACK TO SAVEPOINT s; INSERT …; COMMIT;</code> Without the savepoint, the failed insert would abort the whole transaction.</p>',
      solution: `BEGIN;
INSERT INTO customers (email, full_name, country, city, signup_at) VALUES ('first@lab.test', 'First Try', 'US', 'Austin', now());
SAVEPOINT before_dupe;
INSERT INTO customers (email, full_name, country, city, signup_at) VALUES ('first@lab.test', 'Dupe', 'US', 'Austin', now());
ROLLBACK TO SAVEPOINT before_dupe;
INSERT INTO customers (email, full_name, country, city, signup_at) VALUES ('second@lab.test', 'Second Try', 'US', 'Austin', now());
COMMIT;` },
  ],
},
{
  id: 'locks', title: 'Locks, SKIP LOCKED and job queues', minutes: 20,
  lede: 'MVCC removes most read/write blocking, but writers still lock rows, and every statement takes a table-level lock. Knowing which lock a statement takes is the difference between a migration and an outage.',
  body: `
<h2>Row locks</h2>
<p>UPDATE and DELETE lock the rows they change until the transaction ends. You can also lock rows explicitly:</p>
${TABLE(['Clause', 'Blocks', 'Typical use'], [
  ['<code>FOR UPDATE</code>', 'Other writers and other FOR UPDATE/SHARE lockers', '“I’m about to change this row based on what I read”'],
  ['<code>FOR NO KEY UPDATE</code>', 'Same, but doesn’t block foreign-key checks', 'What a normal UPDATE takes when it doesn’t touch key columns'],
  ['<code>FOR SHARE</code>', 'Writers', '“Nobody change this until I commit”'],
  ['<code>FOR KEY SHARE</code>', 'Deletes and key updates', 'What foreign-key checks take on the parent row'],
])}
<p>Modifiers: <code>NOWAIT</code> errors immediately instead of waiting, and <code>SKIP LOCKED</code> silently skips rows someone else has locked. Row locks are stored in the tuple header (xmax), not in a memory table, so locking a million rows doesn’t exhaust anything.</p>
${S(`BEGIN;
SELECT id, stock FROM products WHERE id = 1 FOR UPDATE;
SELECT locktype, relation::regclass, mode, granted FROM pg_locks WHERE pid = pg_backend_pid();
ROLLBACK;`)}
<h2>Table locks: know these four</h2>
${TABLE(['Statement', 'Lock', 'Blocks'], [
  ['SELECT', 'ACCESS SHARE', 'Only ACCESS EXCLUSIVE'],
  ['INSERT / UPDATE / DELETE', 'ROW EXCLUSIVE', 'SHARE and stronger (for example, a plain CREATE INDEX)'],
  ['CREATE INDEX (plain)', 'SHARE', '<strong>All writes</strong> until it finishes'],
  ['CREATE INDEX CONCURRENTLY, VACUUM, ANALYZE', 'SHARE UPDATE EXCLUSIVE', 'Other DDL and vacuums, not reads or writes'],
  ['Most ALTER TABLE, DROP, TRUNCATE, VACUUM FULL', 'ACCESS EXCLUSIVE', '<strong>Everything</strong>, including SELECT'],
])}
${SIM('ddl-queue', 'deadlock')}
<h2>Job queues with SKIP LOCKED</h2>
<p>Postgres makes an excellent job queue for most workloads (thousands of jobs per second), and you get transactional enqueue for free: the job is committed with the business data or not at all. This is the outbox pattern.</p>
${SIM('skip-locked')}
<p>The worker’s “claim a batch” statement, as a single atomic step:</p>
${S(`-- claim up to 10 runnable jobs without blocking other workers
UPDATE jobs SET status = 'running', locked_at = now(), attempts = attempts + 1
WHERE id IN (
  SELECT id FROM jobs
  WHERE status = 'queued' AND run_at <= now()
  ORDER BY run_at
  LIMIT 10
  FOR UPDATE SKIP LOCKED
)
RETURNING id, payload;`, { norun: true, label: 'Pattern (you’ll build the table in the exercise)' })}
<ul>
  <li>Add a partial index: <code>(run_at) WHERE status = 'queued'</code>.</li>
  <li>Recover from crashed workers by re-queueing <code>running</code> jobs whose <code>locked_at</code> is older than a timeout, or by holding the row lock for the job’s whole duration.</li>
  <li>Wake idle workers with <code>LISTEN/NOTIFY</code> instead of tight polling.</li>
  <li>Delete finished jobs in batches, or partition by time, to avoid bloat.</li>
</ul>
<h2>Advisory locks</h2>
<p><code>pg_advisory_xact_lock(42)</code> takes an application-defined lock that’s released at commit — for example, “only one instance runs the nightly billing job”. <code>pg_try_advisory_lock</code> returns false instead of waiting.</p>
${QUIZ('q-deadlock', 'Two services update accounts in whatever order the request lists them. You see occasional <code>deadlock detected</code> errors. What’s the structural fix?', ['Increase deadlock_timeout', 'Always lock or update rows in a consistent order (e.g. ascending id)', 'Switch to SERIALIZABLE', 'Add an index on accounts'], 1, 'Deadlocks need a cycle, and a consistent lock order makes cycles impossible. You still retry 40P01 as a safety net, but the ordering removes the cause.')}
${INTERVIEW(`<p>“Design a job queue backed by Postgres” is a favorite. Hit these points: SKIP LOCKED, a partial index, recovering crashed workers, retries with backoff, idempotent handlers, LISTEN/NOTIFY, cleanup. Then say when you’d move to Kafka or SQS instead: very high throughput, fan-out to many consumers, cross-service streams.</p>`)}
`,
  exercises: [
    { id: 'm6-claim', title: 'Claim jobs like a worker', setup: `DROP TABLE IF EXISTS jobs;
CREATE TABLE jobs (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  queue     text  NOT NULL DEFAULT 'default',
  payload   jsonb NOT NULL DEFAULT '{}',
  status    text  NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  run_at    timestamptz NOT NULL DEFAULT now(),
  attempts  int NOT NULL DEFAULT 0,
  locked_at timestamptz
);
INSERT INTO jobs (payload, status, run_at)
SELECT jsonb_build_object('email_id', g),
       CASE WHEN g % 3 = 0 THEN 'done' ELSE 'queued' END,
       now() - interval '1 hour' + g * interval '7 seconds' - (g % 5) * interval '13 minutes'
FROM generate_series(1, 1000) g;
CREATE INDEX jobs_runnable_idx ON jobs (run_at) WHERE status = 'queued';`,
      check: { type: 'probe', verify: async (t) => {
        t.need(await t.num(`SELECT count(*) FROM pg_class WHERE relname = 'jobs'`) === 1, 'Press <b>Run setup</b> first.');
        t.need(/skip\s+locked/i.test(t.user), 'Workers must not block each other. Your statement needs FOR UPDATE SKIP LOCKED.');
        t.need(!/\b(begin|commit)\b/i.test(t.user), 'Write only the claiming statement. The checker wraps it in a transaction.');
        return t.inTx(async () => {
          const expected = (await t.rows(`SELECT id FROM jobs WHERE status = 'queued' AND run_at <= now() ORDER BY run_at, id LIMIT 5`)).map((r) => String(r[0])).sort();
          const r = await t.attempt(t.user); if (!r.ok) t.fail('Your statement failed: ' + r.error);
          const res = [...r.results].reverse().find((x) => x.fields.length);
          t.need(res, 'Your statement must RETURN the claimed ids.');
          const got = res.rows.map((x) => String(x[0])).sort();
          t.need(JSON.stringify(got) === JSON.stringify(expected), `Expected to claim the 5 oldest runnable jobs [${expected.join(', ')}] — got [${got.join(', ')}].`);
          const st = await t.rows(`SELECT count(*) FILTER (WHERE status = 'running' AND locked_at IS NOT NULL AND attempts = 1), count(*) FROM jobs WHERE id IN (${expected.join(',')})`);
          t.need(String(st[0][0]) === '5', 'The claimed jobs must end up with status = \'running\', locked_at set and attempts incremented.');
          return 'Claimed exactly the 5 oldest runnable jobs, atomically, without blocking other workers.';
        });
      } },
      prompt: '<p>After <b>Run setup</b>, write <em>one</em> statement for a worker that claims the <strong>5 oldest runnable jobs</strong> (<code>status = \'queued\'</code> and <code>run_at &lt;= now()</code>, oldest <code>run_at</code> first, ties broken by id). It must set <code>status = \'running\'</code> and <code>locked_at = now()</code>, increment <code>attempts</code>, skip rows other workers have locked, and <code>RETURN</code> the ids.</p>',
      hint: '<p>UPDATE … WHERE id IN (SELECT id … ORDER BY run_at, id LIMIT 5 FOR UPDATE SKIP LOCKED) RETURNING id</p>',
      solution: `UPDATE jobs SET status = 'running', locked_at = now(), attempts = attempts + 1
WHERE id IN (
  SELECT id FROM jobs
  WHERE status = 'queued' AND run_at <= now()
  ORDER BY run_at, id
  LIMIT 5
  FOR UPDATE SKIP LOCKED
)
RETURNING id;`,
      alts: [`WITH next AS (SELECT id FROM jobs WHERE status = 'queued' AND run_at <= now() ORDER BY run_at, id LIMIT 5 FOR UPDATE SKIP LOCKED)
UPDATE jobs j SET status = 'running', locked_at = now(), attempts = j.attempts + 1 FROM next WHERE j.id = next.id RETURNING j.id;`] },
  ],
},
{
  id: 'races', title: 'Race conditions: lost updates, idempotency, double booking', minutes: 16,
  lede: 'Most production data bugs aren’t wrong SQL — they’re two correct requests interleaving. The fixes are few and learnable.',
  body: `
${SIM('lost-update', 'atomic-update')}
<h2>Four ways to stop lost updates</h2>
<ol>
  <li><strong>Atomic statement</strong> (best when possible): <code>UPDATE products SET stock = stock - 1 WHERE id = $1 AND stock &gt;= 1 RETURNING stock</code>. Zero rows back means sold out.</li>
  <li><strong>Pessimistic locking:</strong> <code>SELECT … FOR UPDATE</code>, compute in the app, UPDATE, COMMIT — all in one short transaction.</li>
  <li><strong>Optimistic locking:</strong> a <code>version</code> column; <code>UPDATE … SET …, version = version + 1 WHERE id = $1 AND version = $2</code>. Zero rows means someone else won, so re-read and retry. Good for user edits that span HTTP requests.</li>
  <li><strong>Stricter isolation:</strong> REPEATABLE READ or SERIALIZABLE, plus a retry loop.</li>
</ol>
<h2>Check-then-insert races → constraints</h2>
<p>“If no user with this email exists, insert one” races between two requests. The only real fix is a UNIQUE constraint, optionally with <code>ON CONFLICT</code>. The same idea gives you <strong>idempotency keys</strong>: a client retrying a payment sends the same key, and a unique index on it guarantees one payment.</p>
<h2>Double booking → exclusion constraints</h2>
<p>“No two bookings of the same room may overlap” can’t be a UNIQUE constraint, but it can be an <code>EXCLUDE USING gist</code> constraint on a range column. You’ll build one in Module 7. The alternative is to lock a parent row (the room) with FOR UPDATE before checking.</p>
<h2>Hot rows</h2>
<p>A single “total likes” row updated by thousands of requests per second serializes every one of them on its row lock. Batch the increments, shard the counter (N rows, summed on read), or move it to Redis and flush periodically.</p>
${INTERVIEW(`<p>“Two users buy the last item at the same time. How do you prevent overselling?” — the atomic conditional UPDATE with RETURNING, a CHECK (stock &gt;= 0) as the backstop, and why read-then-write in the app fails. “How do you make a payment API idempotent?” — a client-supplied key, a unique index, and returning the original result on retry.</p>`)}
`,
  exercises: [
    { id: 'm6-oversell', title: 'Sell without overselling', check: { type: 'probe', verify: async (t) => {
        t.need(!/\b(begin|commit|rollback)\b/i.test(t.user), 'Write only the UPDATE. The checker wraps it in a transaction.');
        return t.inTx(async () => {
          await t.q('UPDATE products SET stock = 5 WHERE id = 17');
          const r1 = await t.attempt(t.user); if (!r1.ok) t.fail('First run failed: ' + r1.error);
          const res1 = [...r1.results].reverse().find((x) => x.fields.length);
          t.need(res1 && res1.rows.length === 1 && String(res1.rows[0][0]) === '2', `With stock = 5, your statement should return the new stock, 2. It returned ${res1 ? JSON.stringify(res1.rows) : 'no rows (add RETURNING stock)'}.`);
          const r2 = await t.attempt(t.user);
          t.need(r2.ok, 'Second run (stock = 2, need 3) raised an error: ' + r2.error + '. The CHECK constraint caught it, but your statement should simply match no row instead.');
          const res2 = [...r2.results].reverse().find((x) => x.fields.length);
          t.need(!res2 || res2.rows.length === 0, 'With only 2 in stock, the second run should update 0 rows.');
          t.need(await t.num('SELECT stock FROM products WHERE id = 17') === 2, 'Stock should still be 2 after the refused sale.');
          return 'The first sale returned 2; the second found no row to update. No oversell, and no error to handle.';
        });
      } },
      prompt: '<p>Write one statement that sells <strong>3 units of product 17</strong>: decrement <code>stock</code> by 3 <em>only if at least 3 are in stock</em>, and return the new stock. When stock is insufficient, it must update 0 rows (not raise an error). The checker sets stock to 5 and runs your statement twice (expected results: 2, then nothing).</p>',
      hint: '<p>Put the condition in the WHERE clause: <code>… WHERE id = 17 AND stock &gt;= 3 RETURNING stock</code></p>',
      solution: `UPDATE products SET stock = stock - 3
WHERE id = 17 AND stock >= 3
RETURNING stock;`,
      wrong: [`UPDATE products SET stock = stock - 3 WHERE id = 17 RETURNING stock;`] },
    { id: 'm6-idem', title: 'An idempotent payment insert', setup: `DROP TABLE IF EXISTS payments;
CREATE TABLE payments (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  idempotency_key text   NOT NULL UNIQUE,
  customer_id     bigint NOT NULL REFERENCES customers(id),
  amount_cents    int    NOT NULL CHECK (amount_cents > 0),
  created_at      timestamptz NOT NULL DEFAULT now()
);`,
      check: { type: 'probe', verify: async (t) => {
        t.need(await t.num(`SELECT count(*) FROM pg_class WHERE relname = 'payments'`) === 1, 'Press <b>Run setup</b> first.');
        t.need(!/\b(begin|commit|rollback)\b/i.test(t.user), 'Write only the statement. The checker wraps it in a transaction.');
        return t.inTx(async () => {
          await t.q(`DELETE FROM payments WHERE idempotency_key = 'pay_7f3a'`);
          const ids = [];
          for (let i = 1; i <= 3; i++) {
            const r = await t.attempt(t.user); if (!r.ok) t.fail(`Run #${i} failed: ${r.error}`);
            const res = [...r.results].reverse().find((x) => x.fields.length);
            t.need(res && res.rows.length === 1, `Run #${i} returned ${res ? res.rows.length : 0} rows — every run must return exactly one row with the payment id.`);
            ids.push(String(res.rows[0][0]));
          }
          t.need(new Set(ids).size === 1, `The runs returned different ids: ${ids.join(', ')}.`);
          t.need(await t.num(`SELECT count(*) FROM payments WHERE idempotency_key = 'pay_7f3a'`) === 1, 'There should be exactly one payment row for the key.');
          return `Three runs, one payment, same id (${ids[0]}) every time.`;
        });
      } },
      prompt: '<p>After <b>Run setup</b>, write <em>one</em> statement that records a payment with idempotency key <code>\'pay_7f3a\'</code> (customer 42, 5000 cents) and is safe to retry: <strong>every run returns the same payment id</strong>, and only one row ever exists.</p>',
      hint: '<p><code>ON CONFLICT DO NOTHING RETURNING id</code> returns nothing on a retry. Two options: a no-op <code>DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key</code> (always returns the row), or a CTE that falls back to selecting the existing row.</p>',
      solution: `INSERT INTO payments (idempotency_key, customer_id, amount_cents)
VALUES ('pay_7f3a', 42, 5000)
ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
RETURNING id;`,
      alts: [`WITH ins AS (
  INSERT INTO payments (idempotency_key, customer_id, amount_cents) VALUES ('pay_7f3a', 42, 5000)
  ON CONFLICT (idempotency_key) DO NOTHING RETURNING id)
SELECT id FROM ins
UNION ALL
SELECT id FROM payments WHERE idempotency_key = 'pay_7f3a' AND NOT EXISTS (SELECT 1 FROM ins);`],
      wrong: [`INSERT INTO payments (idempotency_key, customer_id, amount_cents) VALUES ('pay_7f3a', 42, 5000) ON CONFLICT DO NOTHING RETURNING id;`],
      explain: 'The no-op DO UPDATE is simple, but it writes a new row version on every retry. The CTE version doesn’t write, but has a subtle race if two first attempts arrive at the same time. In a real API you’d also store the response and compare the request body against the original.' },
  ],
},
]});

/* ═══════════════════════ MODULE 7 — Schema design ═══════════════════════ */
modules.push({ title: 'Schema design', lessons: [
{
  id: 'types', title: 'Types and keys you won’t regret', minutes: 16,
  lede: 'Schema choices outlive the code that made them. A few defaults prevent the outages you read about: integer overflow, timezone bugs, rounding errors, bloated UUID indexes.',
  body: `
${TABLE(['Decision', 'Default', 'Why'], [
  ['Primary key', '<code>bigint GENERATED ALWAYS AS IDENTITY</code>', 'SQL-standard, owns its sequence, prevents accidental manual ids. <code>int</code> tops out at 2.1 billion — companies have gone down on that.'],
  ['Distributed / client-made ids', '<code>uuid</code> via <code>uuidv7()</code> (Postgres 18)', 'Time-ordered, so inserts stay at the right edge of the B-tree. Random v4 UUIDs scatter writes across the whole index.'],
  ['Strings', '<code>text</code> (+ CHECK on length if needed)', '<code>varchar(n)</code> is text plus a length check. Avoid <code>char(n)</code>: it pads with spaces.'],
  ['Money', 'integer cents (<code>bigint</code>) or <code>numeric(12,2)</code>', 'Never float. Beware the <code>money</code> type — it depends on locale.'],
  ['Time', '<code>timestamptz</code>', 'Stores an absolute instant and displays it in the session time zone. <code>timestamp</code> without time zone is a wall-clock reading with no zone, and a bug waiting to happen.'],
  ['Small fixed sets', '<code>CHECK (x IN (…))</code>, an enum, or a lookup table', 'An enum is compact and ordered, but removing values is hard. A lookup table plus FK when values carry data or users manage them.'],
  ['Flexible attributes', '<code>jsonb</code> (not <code>json</code>)', 'Binary and indexable. Anything you filter, join or constrain on should be a real column.'],
  ['Soft delete', '<code>deleted_at timestamptz</code>', 'Beats <code>is_deleted boolean</code>: you get the <em>when</em>, and partial indexes on <code>deleted_at IS NULL</code>.'],
])}
${S(`SELECT uuidv7() AS v7_time_ordered, gen_random_uuid() AS v4_random;
SELECT 0.1::float8 + 0.2::float8 = 0.3::float8 AS float_equal,
       0.1::numeric + 0.2::numeric = 0.3::numeric AS numeric_equal;`)}
<h2>timestamptz, demonstrated</h2>
${S(`SET TIME ZONE 'Asia/Kolkata';
SELECT id, created_at FROM orders WHERE id = 1;
SET TIME ZONE 'America/New_York';
SELECT id, created_at FROM orders WHERE id = 1;
RESET TIME ZONE;`)}
<p>It’s the same stored instant, displayed in two zones. Your application should send and receive timestamptz values, and only format them for a user at the edges.</p>
<h2>Generated columns</h2>
<p><code>GENERATED ALWAYS AS (expr)</code> derives a column from others in the same row. In Postgres 18 the default is <strong>VIRTUAL</strong> (computed on read, takes no space); add <code>STORED</code> to compute on write, which is needed if you want to index it.</p>
${S(`BEGIN;
ALTER TABLE order_items ADD COLUMN line_total_cents bigint GENERATED ALWAYS AS (quantity * unit_price_cents);
SELECT order_id, product_id, quantity, unit_price_cents, line_total_cents FROM order_items LIMIT 3;
ROLLBACK;`)}
<p>Keep the Postgres wiki’s <a href="https://wiki.postgresql.org/wiki/Don%27t_Do_This" target="_blank" rel="noopener">“Don’t Do This”</a> page bookmarked. It’s short and every item is a real lesson.</p>
${QUIZ('q-uuid', 'Why do random (v4) UUID primary keys hurt insert performance on big tables?', ['UUIDs are 16 bytes instead of 8', 'Each insert lands on a random leaf page, so the whole index has to stay in cache and pages split everywhere', 'Postgres can’t index the uuid type'], 1, 'Sequential keys always append to the rightmost leaf, which stays hot in cache. Random keys touch random pages, and once the index is bigger than memory, every insert costs I/O (and extra WAL full-page writes). UUIDv7 keeps the uniqueness and restores locality.')}
${INTERVIEW(`<p>“UUID vs bigint keys?”, “How do you store money?” and “timestamp vs timestamptz?” are rapid-fire checks. Give the default and the reason in one sentence each.</p>`)}
`,
  exercises: [
    { id: 'm7-subs', title: 'Design a subscriptions table', check: { type: 'probe', verify: async (t) => {
        t.need(/create\s+table/i.test(t.user), 'Write a CREATE TABLE subscriptions statement.');
        t.need(!/\b(begin|commit)\b/i.test(t.user), 'Just the DDL, please. The checker runs it in a transaction and rolls back.');
        return t.inTx(async () => {
          await t.q('DROP TABLE IF EXISTS subscriptions CASCADE');
          const r = await t.attempt(t.user); if (!r.ok) t.fail('Your DDL failed: ' + r.error);
          const col = async (c) => t.val(`SELECT format_type(atttypid, atttypmod) || '|' || attidentity::text FROM pg_attribute WHERE attrelid = 'subscriptions'::regclass AND attname = ${lit(c)} AND NOT attisdropped`);
          const id = await col('id'); t.need(id && id.startsWith('bigint|a'), `<code>id</code> should be <code>bigint GENERATED ALWAYS AS IDENTITY</code> (found ${id ? id.replace('|', ', identity=') : 'no id column'}).`);
          const st = await col('started_at'); t.need(st && st.startsWith('timestamp with time zone'), '<code>started_at</code> should be timestamptz.');
          const ins = (cols, vals) => t.attempt(`INSERT INTO subscriptions (${cols}) VALUES (${vals})`);
          const ok = await ins('customer_id, plan, price_cents', `1, 'monthly', 999`);
          t.need(ok.ok, 'A valid row (customer 1, monthly, 999) was rejected: ' + ok.error);
          t.need(await t.num(`SELECT count(*) FROM subscriptions WHERE started_at IS NOT NULL`) === 1, '<code>started_at</code> should default to now().');
          const cases = [
            ['customer_id, plan, price_cents', `1, 'weekly', 999`, 'plan must be monthly or annual'],
            ['customer_id, plan, price_cents', `1, NULL, 999`, 'plan is required'],
            ['customer_id, plan, price_cents', `1, 'annual', 0`, 'price must be positive'],
            ['customer_id, plan, price_cents', `999999999, 'annual', 999`, 'customer must exist (foreign key)'],
            ['customer_id, plan, price_cents, started_at, cancelled_at', `1, 'annual', 999, '2026-01-10', '2026-01-01'`, 'cancelled_at must be after started_at'],
            ['id, customer_id, plan, price_cents', `12345, 1, 'annual', 999`, 'ids must not be set by hand (GENERATED ALWAYS)'],
          ];
          for (const [c, v, why] of cases) { const x = await ins(c, v); t.need(!x.ok, `This insert should have been rejected — ${why}: <code>(${c}) VALUES (${v})</code>`); }
          const cancelOk = await ins('customer_id, plan, price_cents, started_at, cancelled_at', `1, 'annual', 999, '2026-01-01', '2026-03-01'`);
          t.need(cancelOk.ok, 'A valid cancelled subscription was rejected: ' + cancelOk.error);
          return 'All 9 test inserts behaved correctly. Your constraints are the specification.';
        });
      } },
      prompt: `<p>Write a <code>CREATE TABLE subscriptions</code> with:</p><ul><li><code>id</code> — bigint, generated always as identity, primary key</li><li><code>customer_id</code> — required, references customers</li><li><code>plan</code> — required, only <code>'monthly'</code> or <code>'annual'</code></li><li><code>price_cents</code> — required positive integer</li><li><code>started_at</code> — timestamptz, required, defaults to now()</li><li><code>cancelled_at</code> — optional, and if set it must be after <code>started_at</code></li></ul><p>The checker creates your table inside a rolled-back transaction and fires 9 good and bad inserts at it.</p>`,
      hint: '<p>A table-level <code>CHECK (cancelled_at IS NULL OR cancelled_at &gt; started_at)</code> handles the last rule. (A CHECK passes when its expression is NULL, so <code>CHECK (cancelled_at &gt; started_at)</code> alone also works.)</p>',
      solution: `CREATE TABLE subscriptions (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id  bigint NOT NULL REFERENCES customers(id),
  plan         text NOT NULL CHECK (plan IN ('monthly', 'annual')),
  price_cents  integer NOT NULL CHECK (price_cents > 0),
  started_at   timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz,
  CHECK (cancelled_at IS NULL OR cancelled_at > started_at)
);` },
  ],
},
{
  id: 'constraints', title: 'Constraints: the last line of defense', minutes: 16,
  lede: 'Application validation is a courtesy. Constraints are a guarantee — they hold under concurrency, across every service, script and migration that touches the table.',
  body: `
<ul>
  <li><strong>NOT NULL</strong> and <strong>CHECK</strong> — row-level rules. A CHECK can’t look at other rows or tables; use a constraint trigger for that (rarely needed).</li>
  <li><strong>UNIQUE</strong> — backed by a unique index. NULLs count as distinct by default; <code>UNIQUE NULLS NOT DISTINCT</code> (Postgres 15+) changes that.</li>
  <li><strong>FOREIGN KEY</strong> — with <code>ON DELETE RESTRICT / CASCADE / SET NULL</code>. The referenced side needs a unique index. The <em>referencing</em> side doesn’t get one automatically, and should.</li>
  <li><strong>EXCLUDE</strong> — generalizes UNIQUE to any operator, e.g. “no overlapping ranges”.</li>
  <li><strong>DEFERRABLE INITIALLY DEFERRED</strong> — check at COMMIT instead of per statement, which is useful for swaps and circular references.</li>
</ul>
<h2>Unindexed foreign keys cost you on DELETE</h2>
${S(`BEGIN;
CREATE TABLE parent (id int PRIMARY KEY);
CREATE TABLE child (id int PRIMARY KEY, parent_id int REFERENCES parent(id));
INSERT INTO parent SELECT generate_series(1, 1000);
INSERT INTO child SELECT g, (g % 998) + 3 FROM generate_series(1, 200000) g;   -- parents 1 and 2 have no children
EXPLAIN ANALYZE DELETE FROM parent WHERE id = 1;       -- look at the "Trigger for constraint" line
CREATE INDEX ON child (parent_id);
EXPLAIN ANALYZE DELETE FROM parent WHERE id = 2;
ROLLBACK;`)}
<p>Parents 1 and 2 have no children, yet each delete still has to <em>prove</em> that. Without the index, that means scanning the whole child table. The <code>Trigger for constraint child_parent_id_fkey</code> line shows the cost. After the index, that proof is a single B-tree lookup.</p>
<h2>Partial unique indexes</h2>
<p>“Emails must be unique — among customers who haven’t been deleted.” A plain UNIQUE blocks re-signup after a soft delete. A partial unique index expresses exactly the rule:</p>
${S(`CREATE UNIQUE INDEX … ON customers (lower(email)) WHERE deleted_at IS NULL;`, { norun: true, label: 'Shape (the exercise builds it)' })}
<h2>Exclusion constraints: no double booking</h2>
<p><code>EXCLUDE USING gist (room_id WITH =, during WITH &amp;&amp;)</code> reads as: “no two rows may have equal room_id <em>and</em> overlapping during”. <code>tstzrange</code> values are half-open by default (<code>[start, end)</code>), so back-to-back bookings don’t overlap. Using <code>=</code> on a plain integer inside a GiST index requires the <code>btree_gist</code> extension.</p>
${INTERVIEW(`<p>“One active subscription per customer?” → a partial unique index. “Prevent double bookings?” → an exclusion constraint on a range, which is race-free, unlike check-then-insert. “Do foreign keys need indexes?” → on the referencing column, yes, for joins and for parent deletes and updates.</p>`)}
`,
  exercises: [
    { id: 'm7-softuniq', title: 'Unique emails — only among active customers', check: { type: 'state', verify: async (t) => {
        t.need(await t.num(`SELECT count(*) FROM pg_constraint WHERE conname = 'customers_email_key'`) === 0, 'The original <code>customers_email_key</code> UNIQUE constraint still exists. It blocks re-signup after a soft delete, so drop it.');
        return t.inTx(async () => {
          const ins = (email, deleted) => t.attempt(`INSERT INTO customers (email, full_name, country, city, signup_at, deleted_at) VALUES (${lit(email)}, 'Lab', 'US', 'Austin', now(), ${deleted ? 'now()' : 'NULL'})`);
          t.need((await ins('Dup.Test@lab.test', false)).ok, 'Inserting a new active customer failed.');
          t.need(!(await ins('dup.test@lab.test', false)).ok, 'Two <em>active</em> customers could register <code>Dup.Test@lab.test</code> and <code>dup.test@lab.test</code>. Uniqueness must ignore case.');
          t.need((await ins('gone@lab.test', true)).ok && (await ins('gone@lab.test', false)).ok, 'A deleted customer’s email should be reusable by a new active customer.');
          t.need((await ins('gone2@lab.test', true)).ok && (await ins('gone2@lab.test', true)).ok, 'Two deleted rows with the same email should be allowed.');
          return 'Active emails are unique ignoring case; deleted customers don’t block anyone.';
        });
      } },
      prompt: '<p>Replace the plain <code>UNIQUE (email)</code> on customers with a rule that says: <strong>among customers that aren’t soft-deleted</strong> (<code>deleted_at IS NULL</code>), emails are unique <strong>case-insensitively</strong>. The checker tests 7 inserts inside a rolled-back transaction.</p>',
      hint: '<p>Two statements: <code>ALTER TABLE customers DROP CONSTRAINT customers_email_key;</code> and a <code>CREATE UNIQUE INDEX … (lower(email)) WHERE deleted_at IS NULL</code>.</p>',
      solution: `ALTER TABLE customers DROP CONSTRAINT customers_email_key;
CREATE UNIQUE INDEX customers_active_email_uq ON customers (lower(email)) WHERE deleted_at IS NULL;`,
      after: 'Bonus: this index also serves <code>WHERE lower(email) = … AND deleted_at IS NULL</code> lookups, so your login query gets faster too.' },
    { id: 'm7-exclude', title: 'No double-booking', setup: `CREATE EXTENSION IF NOT EXISTS btree_gist;
DROP TABLE IF EXISTS room_bookings;
CREATE TABLE room_bookings (
  id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  room_id int NOT NULL,
  guest   text NOT NULL,
  during  tstzrange NOT NULL
);
INSERT INTO room_bookings (room_id, guest, during) VALUES
  (101, 'Priya', '[2026-07-01 14:00, 2026-07-04 11:00)'),
  (102, 'Liam',  '[2026-07-02 14:00, 2026-07-03 11:00)');`,
      check: { type: 'state', verify: async (t) => {
        t.need(await t.num(`SELECT count(*) FROM pg_class WHERE relname = 'room_bookings'`) === 1, 'Press <b>Run setup</b> first.');
        t.need(await t.num(`SELECT count(*) FROM pg_constraint WHERE conrelid = 'room_bookings'::regclass AND contype = 'x'`) >= 1, 'No exclusion constraint on room_bookings yet.');
        return t.inTx(async () => {
          const ins = (room, range) => t.attempt(`INSERT INTO room_bookings (room_id, guest, during) VALUES (${room}, 'Lab', ${lit(range)})`);
          t.need(!(await ins(101, '[2026-07-03 14:00, 2026-07-05 11:00)')).ok, 'An overlapping booking for room 101 was accepted.');
          t.need((await ins(102, '[2026-07-03 12:00, 2026-07-05 11:00)')).ok, 'A booking for room 102 was rejected even though room 102 is free then. Only the <em>same</em> room may not overlap.');
          t.need((await ins(101, '[2026-07-04 11:00, 2026-07-06 11:00)')).ok, 'A back-to-back booking (checking in exactly at the previous check-out) was rejected. Keep the ranges half-open.');
          return 'Overlaps are rejected by the database itself, and no race condition can get around that.';
        });
      } },
      prompt: '<p>After <b>Run setup</b>, add a constraint to <code>room_bookings</code> so the <em>same room</em> can never have overlapping bookings. Different rooms can overlap freely, and back-to-back stays must be allowed.</p>',
      hint: '<p><code>ALTER TABLE room_bookings ADD CONSTRAINT … EXCLUDE USING gist (room_id WITH =, during WITH &amp;&amp;);</code></p>',
      solution: `ALTER TABLE room_bookings
  ADD CONSTRAINT room_bookings_no_overlap EXCLUDE USING gist (room_id WITH =, during WITH &&);` },
  ],
},
{
  id: 'denormalize', title: 'Normalize by default, denormalize on purpose', minutes: 16,
  lede: 'The normal forms are the easy part. The practical skill is denormalizing deliberately — each copy of data comes with a consistency plan and a known staleness.',
  body: `
<p>Our schema already has one deliberate denormalization: <code>orders.total_cents</code> can be derived from <code>order_items</code>. It’s there so listing and sorting orders by total needs no join and no aggregate. (<code>order_items.unit_price_cents</code> is <em>not</em> a denormalization. It records the price at purchase time, which is different data from today’s price.) Its consistency plan: totals are written in the same transaction as the items, and verified by an audit query — which you’ll write.</p>
${TABLE(['Technique', 'Freshness', 'Consistency mechanism', 'Cost'], [
  ['Materialized view', 'Stale until REFRESH', 'A scheduled <code>REFRESH … CONCURRENTLY</code> (needs a unique index)', 'Full recompute each refresh'],
  ['Summary table + triggers', 'Always fresh', 'Trigger in the same transaction', 'Write latency; hot-row contention'],
  ['Summary table + batch job', 'Minutes', 'Idempotent job, watermark', 'Complexity, lag'],
  ['Generated column', 'Always fresh', 'The database computes it', 'Same-row expressions only'],
  ['Copied attribute (e.g. address at order time)', 'Frozen on purpose', 'Written once', 'Storage'],
])}
<h2>A materialized view</h2>
${S(`DROP MATERIALIZED VIEW IF EXISTS category_sales;
CREATE MATERIALIZED VIEW category_sales AS
SELECT p.category, sum(oi.quantity * oi.unit_price_cents) AS revenue_cents, sum(oi.quantity) AS units
FROM order_items oi JOIN products p ON p.id = oi.product_id
GROUP BY p.category;
SELECT * FROM category_sales ORDER BY revenue_cents DESC;`)}
<p>Reading it is instant. <code>REFRESH MATERIALIZED VIEW</code> recomputes everything and blocks readers meanwhile. <code>REFRESH … CONCURRENTLY</code> doesn’t block readers, but needs a unique index on the view.</p>
<h2>A trigger-maintained summary</h2>
${S(`BEGIN;
CREATE TABLE product_review_stats (product_id bigint PRIMARY KEY, reviews int NOT NULL, rating_sum int NOT NULL);
INSERT INTO product_review_stats SELECT product_id, count(*), sum(rating) FROM reviews GROUP BY product_id;
CREATE FUNCTION bump_review_stats() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO product_review_stats VALUES (NEW.product_id, 1, NEW.rating)
  ON CONFLICT (product_id) DO UPDATE
    SET reviews = product_review_stats.reviews + 1,
        rating_sum = product_review_stats.rating_sum + EXCLUDED.rating_sum;
  RETURN NEW;
END $$;
CREATE TRIGGER reviews_stats AFTER INSERT ON reviews FOR EACH ROW EXECUTE FUNCTION bump_review_stats();
SELECT * FROM product_review_stats WHERE product_id = 1;
INSERT INTO reviews (product_id, customer_id, rating, body, created_at) VALUES (1, 1, 5, 'Great!', now());
SELECT * FROM product_review_stats WHERE product_id = 1;
ROLLBACK;  -- DDL is transactional: the table, function and trigger all disappear`)}
<p>A real version also handles UPDATE and DELETE, and a very popular product becomes a hot row under concurrent reviews.</p>
${JOB(`<p>Denormalize only after you’ve measured, and after an index or query rewrite has failed to fix the problem. Write down the consistency mechanism next to the column (a <code>COMMENT ON COLUMN</code> is perfect), and add an audit query to your monitoring.</p>`)}
${INTERVIEW(`<p>“When would you denormalize?” — read-heavy paths where the join or aggregate dominates, historical snapshots, and precomputed feeds. Then, unprompted, say how you’d keep it consistent and how stale it’s allowed to be. Mentioning CQRS read models or event-driven projections fits system-design rounds.</p>`)}
`,
  exercises: [
    { id: 'm7-audit', title: 'Audit the denormalized totals', setup: `-- a "buggy deploy" corrupts some totals
UPDATE orders SET total_cents = total_cents + 100 WHERE id % 997 = 0;`,
      check: { type: 'result' },
      prompt: '<p>After <b>Run setup</b> (which simulates a buggy deploy), count the orders whose <code>total_cents</code> does <em>not</em> equal the sum of <code>quantity × unit_price_cents</code> over their items. One row, one number.</p>',
      hint: '<p>Aggregate order_items per order in a subquery, join it to orders, and compare.</p>',
      solution: `SELECT count(*)
FROM orders o
JOIN (SELECT order_id, sum(quantity * unit_price_cents) AS items_total FROM order_items GROUP BY order_id) i
  ON i.order_id = o.id
WHERE o.total_cents <> i.items_total;` },
    { id: 'm7-repair', title: 'Repair the totals', setup: `UPDATE orders SET total_cents = total_cents + 100 WHERE id % 997 = 0;`,
      check: { type: 'state', verify: async (t) => {
        const bad = await t.num(`SELECT count(*) FROM orders o JOIN (SELECT order_id, sum(quantity * unit_price_cents) AS s FROM order_items GROUP BY order_id) i ON i.order_id = o.id WHERE o.total_cents <> i.s`);
        t.need(bad === 0, `${bad} orders still have a total that doesn’t match their items.`);
        return 'Every order total matches its items again.';
      } },
      prompt: '<p>Fix every mismatched <code>orders.total_cents</code> with one <code>UPDATE … FROM</code>. Only touch the rows that are actually wrong. (<b>Run setup</b> corrupts some totals, if the previous exercise’s setup hasn’t already.)</p>',
      hint: '<p>Reuse the audit subquery in the FROM list, and add <code>AND o.total_cents &lt;&gt; i.items_total</code> so you don’t rewrite 400k correct rows (which would double the table’s dead tuples).</p>',
      solution: `UPDATE orders o
SET total_cents = i.items_total
FROM (SELECT order_id, sum(quantity * unit_price_cents) AS items_total FROM order_items GROUP BY order_id) i
WHERE i.order_id = o.id AND o.total_cents <> i.items_total;` },
    { id: 'm7-matview', title: 'A materialized view that refreshes without blocking reads', setup: `DROP MATERIALIZED VIEW IF EXISTS daily_revenue;`,
      check: { type: 'state', verify: async (t) => {
        t.need(await t.num(`SELECT count(*) FROM pg_matviews WHERE matviewname = 'daily_revenue'`) === 1, 'No materialized view named <code>daily_revenue</code>.');
        const cols = (await t.rows(`SELECT attname FROM pg_attribute WHERE attrelid = 'daily_revenue'::regclass AND attnum > 0 ORDER BY attnum`)).map((r) => r[0]);
        t.need(['day', 'orders', 'revenue_cents'].every((c) => cols.includes(c)), `Expected columns day, orders, revenue_cents. Found: ${cols.join(', ')}.`);
        t.need(await t.num(`SELECT count(*) FROM pg_index WHERE indrelid = 'daily_revenue'::regclass AND indisunique`) >= 1, 'REFRESH … CONCURRENTLY needs a UNIQUE index on the materialized view.');
        const r = await Engine_exec(t, 'REFRESH MATERIALIZED VIEW CONCURRENTLY daily_revenue'); t.need(r === true, 'A concurrent refresh failed: ' + r);
        const a = await t.num('SELECT sum(revenue_cents) FROM daily_revenue');
        const b = await t.num(`SELECT sum(total_cents) FROM orders WHERE status NOT IN ('cancelled', 'refunded')`);
        t.need(a === b, `The view’s revenue sums to ${a}, but non-cancelled, non-refunded orders sum to ${b}.`);
        return 'The view refreshes concurrently, and its numbers match the source.';
      } },
      prompt: '<p>Create a materialized view <code>daily_revenue</code> with columns <code>day</code> (date), <code>orders</code> (count) and <code>revenue_cents</code> (sum of <code>total_cents</code>), covering orders that are not cancelled or refunded. Make it refreshable with <code>REFRESH MATERIALIZED VIEW CONCURRENTLY</code>.</p>',
      hint: '<p>After CREATE MATERIALIZED VIEW, add <code>CREATE UNIQUE INDEX … ON daily_revenue (day)</code>.</p>',
      solution: `CREATE MATERIALIZED VIEW daily_revenue AS
SELECT created_at::date AS day, count(*) AS orders, sum(total_cents) AS revenue_cents
FROM orders
WHERE status NOT IN ('cancelled', 'refunded')
GROUP BY 1;
CREATE UNIQUE INDEX daily_revenue_day_uq ON daily_revenue (day);
REFRESH MATERIALIZED VIEW CONCURRENTLY daily_revenue;` },
  ],
},
{
  id: 'partitioning', title: 'Partitioning, and when not to', minutes: 16,
  lede: 'Partitioning splits one logical table into many physical ones. It’s a data-lifecycle tool first and a performance tool second — sometimes not a performance tool at all.',
  body: `
<p>Declarative partitioning: create a parent table <code>PARTITION BY RANGE | LIST | HASH (key)</code> (it stores nothing itself) and attach child partitions for value ranges. Queries go to the parent, and the planner routes them.</p>
<h2>What it’s good for</h2>
<ul>
  <li><strong>Retention:</strong> <code>DROP TABLE events_2025_01</code> (or <code>DETACH PARTITION … CONCURRENTLY</code>) removes a month instantly. A <code>DELETE</code> of 50 million rows produces 50 million dead tuples, WAL and replica lag.</li>
  <li><strong>Pruning:</strong> queries filtered by the key skip irrelevant partitions — at plan time for constants, at run time for parameters.</li>
  <li><strong>Smaller units to maintain:</strong> per-partition VACUUM, reindex, or moving old partitions to cheaper storage.</li>
</ul>
<h2>What it costs</h2>
<ul>
  <li>Primary keys and unique constraints must include the partition key.</li>
  <li>Queries <em>without</em> the key touch every partition (lookup by id: N index probes).</li>
  <li>Planning time grows with partition count. Hundreds is fine; tens of thousands is not.</li>
  <li>You have to create future partitions ahead of time (pg_partman or a cron job), or rows land in the DEFAULT partition — or fail to insert at all.</li>
</ul>
<p>A rough guide: consider it for time-series or log tables with a retention policy, or for tables heading past roughly 100 GB with a natural key almost every query filters on. It isn’t the answer to “my 5 GB table is slow” — that’s an index or a query problem.</p>
${S(`-- pruning in action (after you build events_p in the exercise)
EXPLAIN SELECT count(*) FROM events_p
WHERE occurred_at >= '2026-03-10' AND occurred_at < '2026-03-11';`, { label: 'Try after the exercise', noexample: true })}
${INTERVIEW(`<p>“When would you partition?” → retention on time-series, very large tables with a dominant filter key, and hash partitioning for multi-tenant spread. “Partitioning vs sharding?” → partitions live in one server; sharding spreads them across servers (Citus, or application-level), which adds cross-shard queries, distributed transactions and rebalancing.</p>`)}
`,
  exercises: [
    { id: 'm7-partition', title: 'Partition the event log by month', setup: `DROP TABLE IF EXISTS events_p CASCADE;`,
      check: { type: 'state', verify: async (t) => {
        t.need(await t.val(`SELECT relkind FROM pg_class WHERE relname = 'events_p'`) === 'p', '<code>events_p</code> must be a partitioned table (CREATE TABLE … PARTITION BY RANGE (occurred_at)).');
        const key = await t.val(`SELECT pg_get_partkeydef('events_p'::regclass)`);
        t.need(/RANGE \(occurred_at\)/i.test(key), `Partition key should be RANGE (occurred_at); found ${key}.`);
        const parts = await t.num(`SELECT count(*) FROM pg_inherits WHERE inhparent = 'events_p'::regclass`);
        t.need(parts >= 6, `Only ${parts} partitions — create one per month, January through June 2026.`);
        const [a, b] = [await t.num('SELECT count(*) FROM events_p'), await t.num('SELECT count(*) FROM events')];
        t.need(a === b, `events_p has ${a} rows; events has ${b}. Copy everything over.`);
        const nodes = t.nodes(await t.plan(`SELECT count(*) FROM events_p WHERE occurred_at >= '2026-03-10' AND occurred_at < '2026-03-11'`));
        const touched = [...new Set(nodes.filter((n) => n['Relation Name']).map((n) => n['Relation Name']))];
        t.need(touched.length === 1, `A one-day query touches ${touched.length} partitions (${touched.join(', ')}). It should touch exactly one.`);
        return `${parts} partitions, ${a.toLocaleString()} rows, and a one-day query reads only ${touched[0]}.`;
      } },
      prompt: '<p>Create <code>events_p</code>, a copy of <code>events</code> partitioned by <strong>RANGE on occurred_at</strong>, with one partition per month from January to June 2026. Copy all rows from <code>events</code> into it. The checker also verifies that a one-day query is pruned to a single partition.</p>',
      hint: '<p><code>CREATE TABLE events_p (…same columns…) PARTITION BY RANGE (occurred_at);</code>, then for each month <code>CREATE TABLE events_p_2026_01 PARTITION OF events_p FOR VALUES FROM (\'2026-01-01\') TO (\'2026-02-01\');</code>. A <code>DEFAULT</code> partition is a good safety net. Then <code>INSERT INTO events_p SELECT * FROM events;</code></p>',
      solution: `CREATE TABLE events_p (
  id          bigint NOT NULL,
  customer_id bigint,
  event_type  text NOT NULL,
  occurred_at timestamptz NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}'
) PARTITION BY RANGE (occurred_at);
DO $$ BEGIN
  FOR m IN 1..6 LOOP
    EXECUTE format('CREATE TABLE events_p_2026_%s PARTITION OF events_p FOR VALUES FROM (%L) TO (%L)',
                   lpad(m::text, 2, '0'), make_date(2026, m, 1), make_date(2026, m, 1) + interval '1 month');
  END LOOP;
END $$;
CREATE TABLE events_p_default PARTITION OF events_p DEFAULT;
INSERT INTO events_p SELECT * FROM events;
ANALYZE events_p;`,
      teardown: 'DROP TABLE IF EXISTS events_p CASCADE;' },
  ],
},
]});

/* ═══════════════════════ MODULE 8 — Production Postgres ═══════════════════════ */
modules.push({ title: 'Production Postgres', localBest: true, lessons: [
{
  id: 'slow-queries', title: 'Finding the slow query', minutes: 16,
  lede: 'In production, you rarely start with a query. You start with “the app is slow”. The playbook gets you from symptom to plan in minutes.',
  body: `
<ol>
  <li><strong>Is it the database?</strong> Compare app-side timings, connection-pool wait time and network latency before blaming SQL.</li>
  <li><strong>What’s expensive overall?</strong> <code>pg_stat_statements</code>, sorted by <code>total_exec_time</code> (where the time goes), <code>mean_exec_time</code> (the individually slow queries) and <code>calls</code> (chatty queries — often N+1).</li>
  <li><strong>What’s happening right now?</strong> <code>pg_stat_activity</code>: state, wait_event, how long queries and transactions have been open. <code>pg_blocking_pids(pid)</code> finds who blocks whom.</li>
  <li><strong>Why is this one slow?</strong> <code>EXPLAIN (ANALYZE, BUFFERS)</code> with real parameters. <code>auto_explain</code> logs the plans of slow queries automatically.</li>
  <li><strong>Fix, then verify</strong> with before and after numbers from the same view.</li>
</ol>
<h2>pg_stat_statements (live in this lab)</h2>
${JOB(`<p><b>On your own Postgres</b>, this extension only collects data if the server loads it at startup. Enable it once, then restart the server:</p>
<pre style="margin:6px 0 8px">ALTER SYSTEM SET shared_preload_libraries = 'pg_stat_statements';</pre>
<p>On Windows, restart it from an <em>administrator</em> PowerShell with <code>Restart-Service postgresql-x64-18</code> (or Services → postgresql-x64-18 → Restart). <code>ALTER SYSTEM</code> writes <code>postgresql.auto.conf</code>, and some settings only apply after a restart — which is exactly how you’d enable it on a real server. The in-browser engine already has it loaded.</p>`)}
${S(`SELECT round(total_exec_time::numeric, 1) AS total_ms,
       calls,
       round(mean_exec_time::numeric, 2)  AS mean_ms,
       rows,
       left(regexp_replace(query, '\\s+', ' ', 'g'), 90) AS query
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 10;`)}
<p>Queries are normalized — constants become <code>$1</code> — so a query run 10,000 times with different ids shows up as one row with <code>calls = 10000</code>. Reset the view with <code>SELECT pg_stat_statements_reset();</code></p>
<h2>See an N+1 from the database side</h2>
<p>An ORM loop that loads each customer’s orders one query at a time looks like this:</p>
${S(`SET pg_stat_statements.track = 'all';   -- also track statements run inside functions
DO $$ DECLARE r record; t bigint; BEGIN
  FOR r IN SELECT id FROM customers WHERE country = 'SG' LIMIT 100 LOOP
    SELECT sum(total_cents) INTO t FROM orders WHERE customer_id = r.id;
  END LOOP;
END $$;
RESET pg_stat_statements.track;
SELECT calls, round(total_exec_time::numeric, 1) AS total_ms, round(mean_exec_time::numeric, 3) AS mean_ms, query
FROM pg_stat_statements WHERE query ILIKE '%sum(total_cents)%' ORDER BY calls DESC LIMIT 3;`)}
<p>High <code>calls</code> with a tiny <code>mean_ms</code> is the N+1 signature. The fix is one set-based query: <code>… WHERE customer_id = ANY($1) GROUP BY customer_id</code>, or a join.</p>
<h2>Other vital signs</h2>
${S(`-- tables read mostly by sequential scans
SELECT relname, seq_scan, seq_tup_read, idx_scan FROM pg_stat_user_tables ORDER BY seq_tup_read DESC LIMIT 5;
-- cache hit ratio per table (in production you want > 99% for hot tables)
SELECT relname, heap_blks_hit, heap_blks_read,
       round(100.0 * heap_blks_hit / nullif(heap_blks_hit + heap_blks_read, 0), 2) AS hit_pct
FROM pg_statio_user_tables ORDER BY heap_blks_read + heap_blks_hit DESC LIMIT 5;`)}
${JOB(`<p>Turn these on in production: <code>pg_stat_statements</code>, <code>log_min_duration_statement</code> (e.g. 500 ms), <code>auto_explain.log_min_duration</code>, <code>log_lock_waits = on</code>, <code>log_temp_files = 0</code>, <code>track_io_timing = on</code>. Tools like pganalyze, Datadog DBM or pgwatch build on exactly these views.</p>`)}
${INTERVIEW(`<p>“A page got slow — walk me through it.” Go through the playbook in order and name the views. “What is N+1, and how do you spot it from the database?” → a query with huge <code>calls</code> and a tiny mean in pg_stat_statements.</p>`)}
`,
  exercises: [
    { id: 'm8-top', title: 'Your top-statements report', check: { type: 'probe', verify: async (t) => {
        t.need(/pg_stat_statements/i.test(t.user), 'Query the <code>pg_stat_statements</code> view.');
        t.need(/total_exec_time/i.test(t.user) && /order\s+by[\s\S]*desc/i.test(t.user) && /limit\s+5\b/i.test(t.user), 'Order by <code>total_exec_time</code> descending, and LIMIT 5.');
        let res;
        try { res = await t.last(t.user); } catch (e) {
          if (/shared_preload_libraries/.test(e.message)) t.fail('Your Postgres doesn’t load pg_stat_statements yet. Run <code>ALTER SYSTEM SET shared_preload_libraries = \'pg_stat_statements\';</code>, restart the server (Windows: <code>Restart-Service postgresql-x64-18</code> in an admin PowerShell), then check again.');
          throw e;
        }
        t.need(res && res.fields.length >= 4, 'Return at least 4 columns: query, calls, total ms, mean ms.');
        t.need(res.rows.length >= 1 && res.rows.length <= 5, `Expected 1–5 rows, got ${res.rows.length}.`);
        return 'This is the first query you run when “the database is slow”.';
      } },
      prompt: '<p>Write the query you’d keep in your runbook: the <strong>top 5 statements by total execution time</strong>, with <code>query</code>, <code>calls</code>, <code>total_ms</code> (rounded to 1 decimal) and <code>mean_ms</code> (rounded to 2 decimals).</p>',
      hint: '<p><code>total_exec_time</code> and <code>mean_exec_time</code> are double precision. Cast to numeric before <code>round(…, n)</code>.</p>',
      solution: `SELECT query, calls,
       round(total_exec_time::numeric, 1) AS total_ms,
       round(mean_exec_time::numeric, 2)  AS mean_ms
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 5;` },
    { id: 'm8-seqscans', title: 'Which tables are being scanned the hard way?', check: { type: 'result', ordered: true, prepare: 'SELECT pg_stat_force_next_flush()' },
      prompt: '<p>Return the 3 tables that have had the most rows read by <em>sequential</em> scans since the database started: <code>relname</code>, <code>seq_scan</code>, <code>seq_tup_read</code>, highest <code>seq_tup_read</code> first.</p>',
      hint: '<p><code>pg_stat_user_tables</code> has all three columns.</p>',
      solution: `SELECT relname, seq_scan, seq_tup_read FROM pg_stat_user_tables ORDER BY seq_tup_read DESC LIMIT 3;` },
  ],
},
{
  id: 'pagination', title: 'Pagination that doesn’t fall over', minutes: 12,
  lede: 'OFFSET pagination is simple, and gets slower with every page. Keyset pagination stays fast on page one million.',
  body: `
${S(`EXPLAIN ANALYZE
SELECT id, created_at FROM orders
ORDER BY created_at DESC, id DESC
LIMIT 20 OFFSET 200000;`)}
<p>To skip 200,000 rows, Postgres has to produce them and throw them away. Page N costs O(N). OFFSET is also unstable: if new rows arrive between requests, users see duplicates or miss rows.</p>
<h2>Keyset (seek) pagination</h2>
<p>Remember the sort key of the last row you returned, and ask for rows “after” it. A row-value comparison plus a matching composite index turns every page into one index descent and 20 reads:</p>
${S(`CREATE INDEX IF NOT EXISTS orders_created_id_idx ON orders (created_at, id);
EXPLAIN ANALYZE
SELECT id, created_at FROM orders
WHERE (created_at, id) < ('2025-06-01 00:00:00+00', 0)
ORDER BY created_at DESC, id DESC
LIMIT 20;`)}
<ul>
  <li>The sort must be <strong>unique</strong>: add the primary key as a tiebreaker, or rows with equal timestamps get skipped.</li>
  <li><code>(a, b) &lt; (x, y)</code> is a lexicographic comparison, which matches how a composite index is sorted.</li>
  <li>The cursor you send to the client encodes the last row’s key (for example, base64 of <code>created_at|id</code>).</li>
  <li>The trade-off: no “jump to page 57”. Most feeds and APIs don’t need it — look at how Stripe and GitHub paginate.</li>
</ul>
<h2>Total counts</h2>
<p>An exact <code>count(*)</code> over a big filtered set can cost more than the page itself. Options: show an estimate (<code>reltuples</code>, or the row estimate from EXPLAIN), cap it (<code>SELECT count(*) FROM (SELECT 1 FROM … LIMIT 1001) s</code> → “1000+”), or keep a counter.</p>
${INTERVIEW(`<p>“How would you paginate a 100-million-row table for an infinite-scroll API?” → keyset pagination on (sort_col, id) with a composite index, an opaque cursor, and an explanation of why OFFSET degrades. This comes up in API-design rounds too.</p>`)}
`,
  exercises: [
    { id: 'm8-keyset', title: 'Next page, keyset style', check: { type: 'result', ordered: true, extra: async (t) => {
        const nodes = t.nodes(await t.plan(t.lastStmt()));
        const big = nodes.filter((n) => n['Relation Name'] === 'orders' && n['Node Type'] === 'Seq Scan');
        t.need(!big.length, 'Right rows, but the plan still scans all of orders. Make sure an index on <code>(created_at, id)</code> exists and that your WHERE uses a row comparison it can serve.');
        t.need(!sorts(nodes).length, 'Right rows, but the plan still sorts. The index should return rows already in (created_at DESC, id DESC) order.');
      } },
      starter: `WITH cursor AS (
  SELECT created_at, id FROM orders WHERE id = (SELECT max(id) - 5000 FROM orders)
)
SELECT o.id, o.created_at, o.total_cents
FROM orders o, cursor c
WHERE -- your condition here
ORDER BY o.created_at DESC, o.id DESC
LIMIT 20;`,
      prompt: '<p>A feed shows orders newest first, sorted by <code>(created_at DESC, id DESC)</code>. The client’s cursor is the last order it saw: order id = <code>max(id) − 5000</code> (use the starter’s CTE). Return the <strong>next 20 orders</strong> after it — <code>id</code>, <code>created_at</code>, <code>total_cents</code> — with a plan that neither seq-scans nor sorts orders. Create any index you need.</p>',
      hint: '<p><code>WHERE (o.created_at, o.id) &lt; (c.created_at, c.id)</code>, plus <code>CREATE INDEX IF NOT EXISTS … ON orders (created_at, id);</code> above the query.</p>',
      solution: `CREATE INDEX IF NOT EXISTS orders_created_id_idx ON orders (created_at, id);
WITH cursor AS (
  SELECT created_at, id FROM orders WHERE id = (SELECT max(id) - 5000 FROM orders)
)
SELECT o.id, o.created_at, o.total_cents
FROM orders o, cursor c
WHERE (o.created_at, o.id) < (c.created_at, c.id)
ORDER BY o.created_at DESC, o.id DESC
LIMIT 20;` },
  ],
},
{
  id: 'connections', title: 'Connections, pooling and timeouts', minutes: 12,
  lede: 'Postgres forks one process per connection. That single fact explains connection pools, PgBouncer, and a class of outages that happen at the worst possible moment — peak traffic.',
  body: `
<ul>
  <li>Each connection is an OS process with its own memory, and snapshot overhead grows with the number of connections. <code>max_connections</code> is normally a few hundred, not thousands.</li>
  <li>Throughput peaks at a surprisingly small number of <em>active</em> connections — roughly a few per CPU core. Beyond that, adding connections adds contention, not speed.</li>
  <li>Size application pools with the multiplication in mind: <strong>pods × pool size × services</strong>. 20 pods × a pool of 50 = 1,000 connections against a limit of 500.</li>
</ul>
<h2>PgBouncer</h2>
${TABLE(['Mode', 'A server connection is held for…', 'Breaks'], [
  ['session', 'the whole client session', 'Nothing, but it barely multiplexes'],
  ['<b>transaction</b>', 'one transaction', 'Session state: <code>SET</code> (use <code>SET LOCAL</code>), temp tables, session advisory locks, LISTEN, WITH HOLD cursors. Prepared statements need PgBouncer 1.21+ or the driver configured for it.'],
  ['statement', 'one statement', 'Multi-statement transactions'],
])}
<p>Serverless functions and aggressive autoscaling cause connection storms. Put a pooler in front: PgBouncer, RDS Proxy, or Supavisor.</p>
<h2>Timeouts every app should set</h2>
${S(`SHOW max_connections;
SHOW statement_timeout;
SHOW idle_in_transaction_session_timeout;
SELECT pid, state, wait_event_type, wait_event,
       now() - xact_start AS xact_age, left(query, 60) AS query
FROM pg_stat_activity;`)}
<ul>
  <li><code>statement_timeout</code> — per role or per app (e.g. 5 s for web, longer for jobs): <code>ALTER ROLE web SET statement_timeout = '5s';</code></li>
  <li><code>lock_timeout</code> — for migrations especially (next lesson).</li>
  <li><code>idle_in_transaction_session_timeout</code> — kills sessions that opened a transaction and wandered off, holding locks and blocking VACUUM.</li>
  <li><code>transaction_timeout</code> (Postgres 17+) — caps a whole transaction’s duration.</li>
</ul>
${LAB(`<p>You’ll see a single connection in <code>pg_stat_activity</code> — yours — and <code>statement_timeout</code> isn’t enforced in this WebAssembly build, which is why the console has a Stop button.</p>`)}
${QUIZ('q-bouncer', 'Your app runs <code>SET search_path = tenant_42</code> after connecting, then runs queries through PgBouncer in <em>transaction</em> mode. What happens?', ['Works as expected', 'Later queries may run on a different server connection with a different search_path', 'PgBouncer rejects the SET'], 1, 'In transaction mode, consecutive transactions from one client can land on different server connections. Session-level SET leaks to other clients or is lost. Use <code>SET LOCAL</code> inside each transaction, or pass the setting per query.')}
${QUIZ('q-pool', 'Traffic spikes cause “sorry, too many clients already”. What’s the <em>best first</em> move?', ['Raise max_connections to 5000', 'Put a pooler in front and cap each app’s pool, sized for the database’s cores', 'Add a read replica'], 1, 'Thousands of mostly idle connections waste memory and make the active ones slower. Pooling multiplexes many clients onto a small, efficient number of server connections.')}
${INTERVIEW(`<p>“Our app gets connection errors during spikes” → do the pool arithmetic, add a pooler (and name the transaction-mode caveats), set timeouts, and look for leaks (<code>idle in transaction</code>).</p>`)}
`,
},
{
  id: 'migrations', title: 'Zero-downtime schema changes', minutes: 18,
  lede: 'Most Postgres outages you’ll personally cause are migrations. They’re preventable if you know which statement takes which lock, and for how long.',
  body: `
<p>Recall the lock-queue scenario: even an instant ACCESS EXCLUSIVE statement can take a site down while it <em>waits</em> for its lock. So every migration starts with <code>SET lock_timeout = '3s'</code> and is retried with backoff. Then the question is how long the lock is held — which depends on whether Postgres must rewrite or scan the table.</p>
${TABLE(['Change', 'Safe approach'], [
  ['Add a nullable column, or one with a constant default', 'Instant since Postgres 11 — only metadata changes'],
  ['Add a column with a <em>volatile</em> default (<code>random()</code>, <code>clock_timestamp()</code>)', 'Rewrites the table. Add it nullable, backfill in batches, then set the default'],
  ['Add NOT NULL to an existing column', 'Postgres 18: <code>ADD CONSTRAINT … NOT NULL col NOT VALID</code>, then <code>VALIDATE CONSTRAINT</code>. Older: <code>CHECK (col IS NOT NULL) NOT VALID</code> → VALIDATE → <code>SET NOT NULL</code> (skips the scan since PG 12)'],
  ['Add a CHECK or FOREIGN KEY', 'Add it <code>NOT VALID</code> (quick, brief lock), then <code>VALIDATE CONSTRAINT</code> (scans, but doesn’t block writes)'],
  ['Add an index', '<code>CREATE INDEX CONCURRENTLY</code>, then check for an INVALID result'],
  ['Change a column type', 'Usually a rewrite. Expand and contract: new column, dual-write, backfill, switch reads, drop the old one'],
  ['Rename a column or table', 'Breaks running code. Expand and contract, or a compatibility view'],
  ['Drop a column', 'Instant (it’s only marked dropped), but deploy code that stops using it <em>first</em>'],
])}
<h2>See instant vs rewrite</h2>
${S(`SELECT relfilenode FROM pg_class WHERE relname = 'orders';
ALTER TABLE orders ADD COLUMN gift_note text;                        -- metadata only
ALTER TABLE orders ADD COLUMN priority int NOT NULL DEFAULT 0;       -- metadata only (PG 11+)
SELECT relfilenode FROM pg_class WHERE relname = 'orders';           -- unchanged
ALTER TABLE orders ADD COLUMN random_tag float8 DEFAULT random();    -- volatile default: rewrites every row
SELECT relfilenode FROM pg_class WHERE relname = 'orders';           -- a new file: the table was rewritten
ALTER TABLE orders DROP COLUMN gift_note, DROP COLUMN priority, DROP COLUMN random_tag;`)}
<p>Compare the <code>Time:</code> lines. On a 500 GB table, the third statement means hours holding an ACCESS EXCLUSIVE lock.</p>
<h2>Backfills</h2>
<p>Update in batches of roughly 1–10k rows per transaction, by primary-key range, with a short pause between batches. That keeps transactions short, lets VACUUM keep up, avoids replica lag, and lets you stop and resume. A procedure can COMMIT between batches:</p>
${S(`CREATE PROCEDURE backfill_example() LANGUAGE plpgsql AS $$
DECLARE lo bigint := 0; batch int := 10000; maxid bigint;
BEGIN
  SELECT max(id) INTO maxid FROM orders;
  WHILE lo <= maxid LOOP
    UPDATE orders SET coupon_code = upper(coupon_code)
    WHERE id > lo AND id <= lo + batch AND coupon_code IS DISTINCT FROM upper(coupon_code);
    COMMIT;              -- each batch is its own transaction
    lo := lo + batch;
  END LOOP;
END $$;`, { norun: true, label: 'Pattern (read only)' })}
${JOB(`<p>Linters like <strong>squawk</strong> and Rails’ <strong>strong_migrations</strong> encode these rules and catch dangerous migrations in review. Tools like <strong>pgroll</strong> automate expand and contract. Use them — memory fails at 2 a.m.</p>`)}
${INTERVIEW(`<p>“Add a NOT NULL column with a default to a 1-billion-row table with zero downtime.” → a constant default is instant since PG 11. For computed values: add the column nullable, backfill in batches, add NOT NULL as NOT VALID and validate it (PG 18) or use the CHECK trick, all under <code>lock_timeout</code> with retries. Mention replication lag while backfilling.</p>`)}
`,
  exercises: [
    { id: 'm8-check', title: 'Add a CHECK without blocking writes', setup: `DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT conname FROM pg_constraint WHERE conrelid = 'orders'::regclass AND contype = 'c'
           AND pg_get_constraintdef(oid) ~ 'total_cents' LOOP
    EXECUTE 'ALTER TABLE orders DROP CONSTRAINT ' || quote_ident(r.conname);
  END LOOP; END $$;`,
      check: { type: 'state', verify: async (t) => {
        const rows = await t.rows(`SELECT conname, convalidated FROM pg_constraint WHERE conrelid = 'orders'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ~ 'total_cents\\s*>=\\s*0'`);
        t.need(rows.length, 'No CHECK (total_cents >= 0) constraint on orders yet.');
        t.need(rows.some((r) => r[1] === 't' || r[1] === true), `Constraint ${rows[0][0]} exists but is still NOT VALID. Validate it.`);
        return 'The constraint is enforced and validated. On a busy table, the NOT VALID → VALIDATE route kept writes flowing.';
      } },
      prompt: '<p>Add the constraint <code>CHECK (total_cents &gt;= 0)</code> to <code>orders</code> the production-safe way: set a lock timeout, add it without scanning existing rows, then validate it in a separate step.</p>',
      hint: '<p><code>ALTER TABLE … ADD CONSTRAINT … CHECK (…) NOT VALID;</code> then <code>ALTER TABLE … VALIDATE CONSTRAINT …;</code></p>',
      solution: `SET lock_timeout = '3s';
ALTER TABLE orders ADD CONSTRAINT orders_total_nonneg CHECK (total_cents >= 0) NOT VALID;
ALTER TABLE orders VALIDATE CONSTRAINT orders_total_nonneg;
RESET lock_timeout;` },
    { id: 'm8-notnull', title: 'NOT NULL, the Postgres 18 way', setup: `ALTER TABLE customers DROP COLUMN IF EXISTS acquisition_channel;
ALTER TABLE customers ADD COLUMN acquisition_channel text;   -- a new nullable column, empty for all rows`,
      check: { type: 'state', verify: async (t) => {
        t.need(await t.num(`SELECT count(*) FROM pg_attribute WHERE attrelid = 'customers'::regclass AND attname = 'acquisition_channel' AND NOT attisdropped`) === 1, 'Press <b>Run setup</b> first.');
        t.need(await t.num('SELECT count(*) FROM customers WHERE acquisition_channel IS NULL') === 0, 'Some customers still have acquisition_channel = NULL. Backfill them with \'organic\'.');
        const def = await t.val(`SELECT pg_get_expr(d.adbin, d.adrelid) FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum WHERE d.adrelid = 'customers'::regclass AND a.attname = 'acquisition_channel'`);
        t.need(def && /organic/.test(def), 'New rows should default to \'organic\'.');
        return t.inTx(async () => {
          const r = await t.attempt(`INSERT INTO customers (email, full_name, country, city, signup_at, acquisition_channel) VALUES ('nn@lab.test', 'Lab', 'US', 'Austin', now(), NULL)`);
          t.need(!r.ok, 'A NULL acquisition_channel was still accepted. Add and validate a NOT NULL constraint.');
          const inv = await t.num(`SELECT count(*) FROM pg_constraint WHERE conrelid = 'customers'::regclass AND contype = 'n' AND NOT convalidated`);
          t.need(inv === 0, 'There’s still a NOT VALID not-null constraint. Run VALIDATE CONSTRAINT.');
          return 'Backfilled, defaulted, and enforced — without a long exclusive lock.';
        });
      } },
      prompt: '<p>After <b>Run setup</b>, <code>customers.acquisition_channel</code> exists and is NULL everywhere. Make it a proper required column: default <code>\'organic\'</code> for new rows, backfill existing rows with <code>\'organic\'</code>, then enforce NOT NULL using Postgres 18’s <code>NOT VALID</code> → <code>VALIDATE</code> route.</p>',
      hint: '<p>Order matters: SET DEFAULT → UPDATE (in production: in batches) → <code>ALTER TABLE customers ADD CONSTRAINT name NOT NULL acquisition_channel NOT VALID;</code> → <code>ALTER TABLE customers VALIDATE CONSTRAINT name;</code></p>',
      solution: `ALTER TABLE customers ALTER COLUMN acquisition_channel SET DEFAULT 'organic';
UPDATE customers SET acquisition_channel = 'organic' WHERE acquisition_channel IS NULL;
ALTER TABLE customers ADD CONSTRAINT customers_acq_not_null NOT NULL acquisition_channel NOT VALID;
ALTER TABLE customers VALIDATE CONSTRAINT customers_acq_not_null;` },
  ],
},
{
  id: 'ha', title: 'Replication, backups and keeping the lights on', minutes: 16,
  lede: 'You may never configure replication yourself, but you’ll design around its properties: lag, failover, and what “restorable” actually means.',
  body: `
<h2>WAL: the source of truth</h2>
<p>Every change is first written to the <strong>write-ahead log</strong>. A COMMIT is durable once its WAL is flushed to disk (unless you choose <code>synchronous_commit = off</code> and accept losing the last few milliseconds in a crash). Data pages are written lazily and made consistent at <em>checkpoints</em>. Crash recovery replays WAL from the last checkpoint. Replication and point-in-time recovery are both “ship the WAL somewhere else and replay it”.</p>
${S(`SELECT pg_current_wal_lsn(), pg_walfile_name(pg_current_wal_lsn());
SHOW wal_level;
SHOW synchronous_commit;
SHOW max_wal_size;`)}
<h2>Replication</h2>
${TABLE(['Kind', 'What moves', 'Use for', 'Watch for'], [
  ['Physical streaming', 'WAL bytes → an identical standby', 'HA failover, read replicas', 'Replication lag, and conflicts when replay needs to remove rows a replica query is using'],
  ['Synchronous', 'Same, but COMMIT waits for a standby', 'Zero data loss on failover', 'Every commit pays the round-trip latency'],
  ['Logical', 'Row changes per table (publish/subscribe)', 'Zero-downtime major upgrades, partial replication, CDC to Kafka (Debezium)', 'Sequences and DDL aren’t replicated; replication slots retain WAL'],
])}
<p><strong>Read-your-writes:</strong> a user saves a profile, the next page reads from an async replica, and the old data comes back. Fixes: read from the primary for a while after a write, route by session, or wait until the replica has replayed the commit’s LSN.</p>
<p><strong>Replication slots</strong> make the primary keep WAL until the consumer confirms it. An abandoned slot (a dead Debezium connector, a removed replica) keeps WAL forever, and the disk fills up. Monitor <code>pg_replication_slots</code>.</p>
<h2>Backups</h2>
<ul>
  <li><strong>pg_dump</strong> — a logical snapshot of one database. Portable and selective, but restoring a big one is slow (indexes rebuild), and there’s no point-in-time.</li>
  <li><strong>Base backup + WAL archive</strong> (pgBackRest, WAL-G, managed snapshots) — restore to <em>any moment</em>: point-in-time recovery (PITR). This is the production standard.</li>
  <li>Know your <strong>RPO</strong> (how much data you can lose) and <strong>RTO</strong> (how long a restore takes). A backup you’ve never restored is a hypothesis — test restores regularly.</li>
</ul>
<h2>Failover and upgrades</h2>
<p>Managed services (RDS/Aurora, Cloud SQL, Azure) or Patroni on your own servers promote a standby when the primary dies. Clients must reconnect and retry. Plan for a few seconds of errors, not zero. Major upgrades use <code>pg_upgrade</code> (which since 18 keeps planner statistics), or logical replication to a new-version cluster for near-zero downtime.</p>
<h2>The scaling ladder</h2>
<ol>
  <li>Fix queries and indexes. This solves most problems.</li><li>Scale up: more RAM means more cache hits.</li><li>Pool connections.</li><li>Cache hot reads (Redis, the application).</li><li>Read replicas for read-heavy traffic (mind the lag).</li><li>Partition big tables for lifecycle and maintenance.</li><li>Move workloads elsewhere: analytics to a warehouse, search to a search engine.</li><li>Shard (Citus, or application-level) — last, because it complicates everything.</li>
</ol>
${QUIZ('q-lag', 'A user updates their profile, refreshes, and sees the old value. A second later it’s correct. The most likely cause?', ['A missing index', 'The refresh read from an asynchronous read replica that hadn’t replayed the change yet', 'VACUUM hadn’t run'], 1, 'Classic replica lag. Route a user’s reads to the primary for a short window after they write, or check the replica’s replay LSN.')}
${QUIZ('q-slot', 'The primary’s disk keeps filling with WAL files, and there’s no unusual write traffic. Where do you look first?', ['pg_stat_statements', 'pg_replication_slots — an inactive slot is retaining WAL', 'work_mem'], 1, 'A slot whose consumer disappeared stops WAL from being recycled. Drop the slot, or fix its consumer. Postgres 13+ can cap retention with <code>max_slot_wal_keep_size</code>.')}
${QUIZ('q-pitr', 'Which backup strategy lets you restore the database to 14:32 yesterday, just before a bad deploy ran a destructive migration?', ['A nightly pg_dump', 'A base backup plus continuous WAL archiving (PITR)', 'A streaming replica'], 1, 'Replay WAL from the last base backup up to a target time. A replica doesn’t help: it replays the bad migration too, within milliseconds.')}
${INTERVIEW(`<p>In system design, say the ladder out loud before reaching for sharding. When replicas come up, mention lag and read-your-writes without being asked. For durability, name PITR, RPO/RTO and restore drills.</p>`)}
`,
},
]});

/* ═══════════════════════ MODULE 9 — Interview arena ═══════════════════════ */
modules.push({ title: 'Interview arena', lessons: [
{
  id: 'puzzles', title: 'SQL interview puzzles', minutes: 40,
  lede: 'Six classics, checked against real data. Time yourself: about 10 minutes each is interview pace. Say your assumptions (ties? NULLs?) before you type.',
  body: `
<p>A good way to work through each one out loud:</p>
<ol><li><strong>Clarify</strong> the output shape, ties, NULLs and time zones.</li><li>Write the <strong>skeleton</strong>: FROM and JOIN first, then filters, then grouping or windows.</li><li><strong>Test</strong> on a tiny slice (<code>WHERE customer_id &lt;= 3</code>) before running it on everything.</li><li><strong>Talk about performance</strong>: which index you’d add, and what the plan would be.</li></ol>
${WARN(`<p>If a query runs for more than a few seconds, press <b>Stop</b> in the console. It restarts the engine from your last snapshot.</p>`)}
`,
  exercises: [
    { id: 'm9-second', title: 'Second-highest salary in each department', check: { type: 'result' },
      prompt: '<p>For each department, return the second-highest <em>distinct</em> salary. Columns: <code>department</code>, <code>salary</code>, one row per department. Departments with only one distinct salary return no row.</p>',
      hint: '<p><code>dense_rank()</code> = 2, deduplicated. Or <code>max(salary)</code> among salaries below the department’s maximum.</p>',
      solution: `SELECT department, salary FROM (
  SELECT DISTINCT department, salary,
         dense_rank() OVER (PARTITION BY department ORDER BY salary DESC) AS r
  FROM employees
) s WHERE r = 2;`,
      alts: [`SELECT department, max(salary) FROM employees e WHERE salary < (SELECT max(salary) FROM employees x WHERE x.department = e.department) GROUP BY department;`] },
    { id: 'm9-manager', title: 'Employees who earn more than their manager', check: { type: 'result' },
      prompt: '<p>Return every employee whose salary is strictly greater than their direct manager’s: <code>id</code>, <code>full_name</code>, <code>salary</code>, <code>manager_name</code>, <code>manager_salary</code>.</p>',
      hint: '<p>A self-join: <code>employees e JOIN employees m ON m.id = e.manager_id</code>.</p>',
      solution: `SELECT e.id, e.full_name, e.salary, m.full_name AS manager_name, m.salary AS manager_salary
FROM employees e
JOIN employees m ON m.id = e.manager_id
WHERE e.salary > m.salary;` },
    { id: 'm9-dedupe', title: 'Delete duplicate signups, keep the earliest', setup: `DROP TABLE IF EXISTS signups_raw;
CREATE TABLE signups_raw (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email      text NOT NULL,
  source     text,
  created_at timestamptz NOT NULL
);
INSERT INTO signups_raw (email, source, created_at)
SELECT 'user' || (g % 700) || '@lab.test', (ARRAY['ads', 'organic', 'referral'])[1 + g % 3],
       timestamptz '2026-01-01' + g * interval '17 minutes'
FROM generate_series(1, 2000) g;`,
      check: { type: 'state', verify: async (t) => {
        t.need(await t.num(`SELECT count(*) FROM pg_class WHERE relname = 'signups_raw'`) === 1, 'Press <b>Run setup</b> first.');
        const [n, d, lo, hi] = (await t.rows('SELECT count(*), count(DISTINCT email), min(id), max(id) FROM signups_raw'))[0].map(Number);
        t.need(d === 700, `There should still be 700 distinct emails; found ${d}. Did you delete too much? Run setup again to start over.`);
        t.need(n === 700, `${n} rows remain for 700 emails — duplicates are still there.`);
        t.need(lo === 1 && hi === 700, 'One row per email remains, but not always the <em>earliest</em> one.');
        return '2,000 rows → 700, keeping each email’s first signup.';
      } },
      prompt: '<p>After <b>Run setup</b>, <code>signups_raw</code> has 2,000 rows for 700 distinct emails. Delete the duplicates so exactly one row per email remains: the one with the <strong>earliest</strong> <code>created_at</code>.</p>',
      hint: '<p>Either <code>DELETE … USING signups_raw d WHERE s.email = d.email AND (s.created_at, s.id) &gt; (d.created_at, d.id)</code>, or delete ids whose <code>row_number() OVER (PARTITION BY email ORDER BY created_at, id)</code> is greater than 1.</p>',
      solution: `DELETE FROM signups_raw WHERE id IN (
  SELECT id FROM (
    SELECT id, row_number() OVER (PARTITION BY email ORDER BY created_at, id) AS rn
    FROM signups_raw
  ) x WHERE rn > 1
);`,
      teardown: 'DROP TABLE IF EXISTS signups_raw;' },
    { id: 'm9-streak', title: 'Longest login streak (gaps and islands)', setup: `DROP TABLE IF EXISTS logins;
CREATE TABLE logins (user_id int NOT NULL, day date NOT NULL, PRIMARY KEY (user_id, day));
INSERT INTO logins
SELECT u, d::date
FROM generate_series(1, 50) u, generate_series(date '2026-01-01', date '2026-03-31', interval '1 day') d
WHERE (u * 7 + extract(doy FROM d)::int * 13) % 10 < 6
   OR (u % 5 = 0 AND d BETWEEN date '2026-02-01' AND date '2026-02-20');`,
      check: { type: 'result' },
      prompt: '<p>After <b>Run setup</b>, <code>logins(user_id, day)</code> has one row per user per day they logged in. For every user, return their longest run of <strong>consecutive days</strong>: <code>user_id</code>, <code>longest_streak</code>.</p>',
      hint: '<p>The trick: within a streak, <code>day - row_number()</code> is constant. Group by <code>(user_id, day - row_number() OVER (PARTITION BY user_id ORDER BY day)::int)</code>, count each group, then take the max per user.</p>',
      solution: `SELECT user_id, max(len) AS longest_streak FROM (
  SELECT user_id, count(*) AS len FROM (
    SELECT user_id, day, day - (row_number() OVER (PARTITION BY user_id ORDER BY day))::int AS grp
    FROM logins
  ) s GROUP BY user_id, grp
) t GROUP BY user_id;` },
    { id: 'm9-retention', title: 'Cohort retention: back within 30 days?', check: { type: 'result', ordered: true },
      prompt: '<p>For customers who signed up in 2025, grouped by signup month (<code>date_trunc(\'month\', signup_at)</code>), return <code>cohort</code>, <code>signups</code>, and <code>retained</code>: how many of them placed their <em>first</em> order within 30 days of signing up. Order by cohort. Aim for one pass over orders, not one subquery per customer.</p>',
      hint: '<p>Compute each customer’s first order once (<code>min(created_at) … GROUP BY customer_id</code>), LEFT JOIN it to customers, and count with <code>FILTER (WHERE first_at &lt; signup_at + interval \'30 days\')</code>.</p>',
      solution: `WITH first_order AS (
  SELECT customer_id, min(created_at) AS first_at FROM orders GROUP BY customer_id
)
SELECT date_trunc('month', c.signup_at) AS cohort,
       count(*) AS signups,
       count(*) FILTER (WHERE f.first_at < c.signup_at + interval '30 days') AS retained
FROM customers c
LEFT JOIN first_order f ON f.customer_id = c.id
WHERE c.signup_at >= '2025-01-01' AND c.signup_at < '2026-01-01'
GROUP BY 1
ORDER BY 1;` },
    { id: 'm9-mom', title: 'Month-over-month revenue growth', check: { type: 'result', ordered: true },
      prompt: '<p>For 2025, return <code>month</code>, <code>revenue</code> (sum of <code>total_cents</code> for <em>delivered</em> orders) and <code>growth_pct</code>: the percentage change versus the previous month, as <code>round(numeric, 1)</code>. January’s is NULL. Order by month.</p>',
      hint: '<p>Aggregate per month in a subquery, then <code>round(100.0 * (revenue - lag(revenue) OVER w) / lag(revenue) OVER w, 1)</code>.</p>',
      solution: `SELECT month, revenue,
       round(100.0 * (revenue - lag(revenue) OVER (ORDER BY month)) / lag(revenue) OVER (ORDER BY month), 1) AS growth_pct
FROM (
  SELECT date_trunc('month', created_at) AS month, sum(total_cents) AS revenue
  FROM orders
  WHERE status = 'delivered' AND created_at >= '2025-01-01' AND created_at < '2026-01-01'
  GROUP BY 1
) m
ORDER BY month;` },
  ],
},
{
  id: 'concepts', title: 'Concept questions, with model answers', minutes: 30,
  lede: 'The questions that come up again and again, in interviews and design reviews, with the kind of answer that lands in about 60 seconds. Try answering out loud first, then open the card.',
  body: `
<div class="cards">
${[
  ['What physically happens when you UPDATE a row?', '<p>Postgres writes a <em>new tuple version</em>, sets xmax on the old one, and (unless it’s a HOT update) inserts new entries into every index. The old version stays until VACUUM removes it, once no snapshot needs it. Consequences: updates cost about as much as inserts, update-heavy tables bloat, and indexed columns block HOT.</p>'],
  ['What does VACUUM do, and why is autovacuum critical?', '<p>It removes dead tuples that no snapshot needs, makes their space reusable, updates the visibility map (index-only scans) and free-space map, and freezes old xids to prevent wraparound. It doesn’t shrink files — VACUUM FULL and pg_repack do. Autovacuum does this continuously. Tune it per big table (a lower <code>autovacuum_vacuum_scale_factor</code>), and never just disable it.</p>'],
  ['Explain MVCC in Postgres.', '<p>Every row version records the transaction that created it (xmin) and the one that deleted it (xmax). A statement or transaction uses a snapshot of which transactions are committed, and sees only the versions visible to it. Readers never block writers or the other way round. The cost is dead versions, so you need VACUUM.</p>'],
  ['What are the isolation levels and Postgres’s default?', '<p>READ COMMITTED (default): a snapshot per statement, so non-repeatable reads and lost updates in read-modify-write code are possible. REPEATABLE READ: one snapshot per transaction, errors on concurrent updates, write skew still possible. SERIALIZABLE: SSI, “as if serial”, with retries on 40001. There are never dirty reads.</p>'],
  ['A query got slow. What do you do?', '<p>Confirm it’s the database; find the query and its trend in pg_stat_statements; <code>EXPLAIN (ANALYZE, BUFFERS)</code> with real parameters; find the most expensive node; compare estimated vs actual rows; check for locks or waits in pg_stat_activity; fix one thing (index, ANALYZE or extended statistics, query rewrite, work_mem); measure again.</p>'],
  ['Why might Postgres not use an index?', '<p>Low selectivity (a seq scan really is cheaper), a function or cast on the column, a type mismatch, a leading-wildcard LIKE, the index not leading with the filtered column, stale statistics or correlated columns causing bad estimates, a tiny table, or a generic plan for a prepared statement.</p>'],
  ['B-tree vs GIN vs GiST vs BRIN?', '<p>B-tree: scalar =, ranges, sorting, uniqueness. GIN: many keys per row — jsonb containment, arrays, full-text, trigram. GiST: ranges and overlaps, geometry, nearest-neighbour, exclusion constraints. BRIN: huge append-only tables whose value follows physical order, and it’s tiny.</p>'],
  ['How do you order columns in a composite index?', '<p>Equality predicates first, then the sort or range column (ESR). The index then serves the filter, the ORDER BY and the LIMIT together. An index on (a, b) makes one on (a) redundant. Postgres 18’s skip scan can use (a, b) for <code>b = ?</code> when a has few distinct values, but don’t design for it.</p>'],
  ['What is a covering index / index-only scan?', '<p>An index containing every column the query needs (key columns plus <code>INCLUDE</code> columns). Postgres skips the heap for pages the visibility map marks all-visible. Heap Fetches in EXPLAIN shows how often it couldn’t, which is why VACUUM matters for index-only scans.</p>'],
  ['Does Postgres have clustered indexes?', '<p>No. Tables are heaps and every index is secondary, pointing at a ctid. <code>CLUSTER</code> sorts the table once and isn’t maintained. That differs from InnoDB, where the primary key <em>is</em> the table. It’s one reason random UUID primary keys hurt InnoDB even more.</p>'],
  ['Why is count(*) slow?', '<p>Postgres doesn’t store a row count, because visibility depends on the snapshot. Counting visits the heap, or an index plus the visibility map. For UIs, use estimates (reltuples, the EXPLAIN estimate), capped counts, or maintained counters.</p>'],
  ['OFFSET vs keyset pagination?', '<p>OFFSET N must generate and discard N rows (O(N)) and is unstable under inserts. Keyset uses <code>WHERE (sort, id) &lt; (last_sort, last_id) ORDER BY sort DESC, id DESC LIMIT k</code> with a composite index: constant cost per page and stable, but no random page access.</p>'],
  ['How do you prevent overselling / lost updates?', '<p>An atomic conditional update: <code>UPDATE … SET stock = stock - n WHERE id = $1 AND stock &gt;= n RETURNING stock</code>. Or SELECT … FOR UPDATE, optimistic version checks, or stricter isolation with retries. Keep a CHECK (stock &gt;= 0) as the backstop.</p>'],
  ['Design a job queue on Postgres.', '<p>A jobs table (status, run_at, attempts, locked_at); workers claim with <code>UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED LIMIT n) RETURNING</code>; a partial index on queued jobs; re-queue stale running jobs; retry with backoff; idempotent handlers; LISTEN/NOTIFY to wake workers; batch cleanup or partitions. Enqueue in the same transaction as the business write (outbox).</p>'],
  ['What causes deadlocks and how do you avoid them?', '<p>Two transactions each hold a lock the other needs. Postgres detects the cycle after deadlock_timeout and aborts one (40P01). Avoid them with a consistent lock order, short transactions, and locking everything up front (<code>SELECT … ORDER BY id FOR UPDATE</code>). Retry as a safety net.</p>'],
  ['How do you add an index or column to a huge live table?', '<p>Indexes: CREATE INDEX CONCURRENTLY, then check for INVALID. Columns: nullable or constant-default adds are instant (PG 11+). Constraints: NOT VALID, then VALIDATE. Everything under <code>lock_timeout</code> with retries, so you never queue behind a long transaction. Backfill in batches.</p>'],
  ['Why connection pooling? PgBouncer modes?', '<p>A process per connection makes connections expensive, and throughput peaks at a few active connections per core. Poolers multiplex many clients onto a few server connections. Transaction mode is the common choice; it breaks session state (SET, temp tables, session advisory locks, LISTEN), so use SET LOCAL.</p>'],
  ['Physical vs logical replication? Sync vs async?', '<p>Physical ships WAL to an identical standby (HA, read replicas). Logical publishes row changes per table (upgrades, CDC, partial copies). Async can lose the last few transactions on failover and shows lag; sync waits for a standby on every commit (no loss, more latency).</p>'],
  ['pg_dump vs PITR?', '<p>pg_dump is a logical, portable snapshot: slow restores for big databases and no point-in-time. Base backups plus WAL archiving let you restore to any moment (PITR) — the production standard. Know your RPO and RTO, and test restores.</p>'],
  ['When would you partition? Partitioning vs sharding?', '<p>Partition for retention (drop old partitions instantly), for very large tables with a dominant filter key, and for per-partition maintenance. It’s not a fix for a slow 5 GB table. Sharding spreads data across servers (Citus or the application), adding cross-shard queries, distributed transactions and rebalancing — do it last.</p>'],
  ['Normalization vs denormalization in practice?', '<p>Normalize by default (3NF) for correctness. Denormalize measured hot read paths — materialized views, summary tables, cached columns — each with an explicit consistency mechanism (same transaction, trigger, job) and a known staleness. Historical snapshots (price at purchase) aren’t denormalization; they’re different facts.</p>'],
  ['UUID or bigint primary keys?', '<p>Default to bigint identity: small, fast, sequential. Use UUIDs when ids are generated outside the database, must be unguessable, or merge across systems — and prefer UUIDv7 (time-ordered) over v4 to keep index locality. Always the uuid type, never text.</p>'],
  ['What is WAL? What is a checkpoint?', '<p>The write-ahead log records every change before data pages are written, which gives durability, crash recovery, replication and PITR. A checkpoint flushes dirty pages so recovery can start from it. Too-frequent checkpoints cause I/O spikes and extra full-page writes; tune max_wal_size.</p>'],
  ['What is transaction ID wraparound?', '<p>Xids are 32 bits and compared modularly, so tuples older than about 2 billion transactions must be frozen or they’d look like they’re in the future. Autovacuum freezes as it goes. If it falls behind (long transactions, disabled autovacuum, huge tables), Postgres forces anti-wraparound vacuums and eventually stops accepting writes. Monitor <code>age(datfrozenxid)</code>.</p>'],
  ['Postgres vs MySQL — notable differences?', '<p>Heap tables vs InnoDB’s clustered primary key; READ COMMITTED default vs REPEATABLE READ with gap locks; MVCC cleanup by VACUUM vs InnoDB’s undo log purge; transactional DDL in Postgres; richer types, indexes and extensions (jsonb/GIN, ranges, exclusion constraints, PostGIS); process-per-connection vs threads.</p>'],
  ['When is JSONB the right choice?', '<p>Sparse or varying attributes, rarely-filtered metadata, payloads you store and return as-is. Promote to real columns anything you filter, join, aggregate or constrain. Index containment queries with GIN, and <code>-&gt;&gt;</code> lookups with expression B-trees.</p>'],
  ['What does ANALYZE do, and when do you run it manually?', '<p>It samples the table and updates planner statistics (MCVs, histograms, n_distinct, correlation, extended stats). Run it after bulk loads or deletes, after creating extended statistics or expression indexes, and after restores or major upgrades (PG 18’s pg_upgrade keeps stats).</p>'],
  ['What is the N+1 problem, and how do you see it in the database?', '<p>An ORM loads a list, then runs one query per item. In pg_stat_statements it’s a statement with an enormous <code>calls</code> count and a tiny mean time. The fix is eager loading, <code>WHERE id = ANY($1)</code>, or a join.</p>'],
].map(([q, a]) => `<details class="card"><summary>${q}</summary><div class="ans">${a}</div></details>`).join('')}
</div>
`,
},
{
  id: 'design', title: 'Postgres in system-design rounds', minutes: 20,
  lede: 'In design interviews, Postgres is usually the right first answer. The signal is knowing how far it goes, what the schema and indexes look like, and what you’d change as the numbers grow.',
  body: `
<p>For each prompt, practice a two-minute answer covering <strong>tables, key indexes, the hot queries, the concurrency hazard, and the first scaling step</strong>.</p>
<div class="cards">
${[
  ['Multi-tenant SaaS', '<ul><li><code>tenant_id</code> on every table, leading every composite index and unique constraint: <code>(tenant_id, email)</code>.</li><li>Row-level security (<code>CREATE POLICY … USING (tenant_id = current_setting(\'app.tenant\')::bigint)</code>) as defense in depth.</li><li>Noisy neighbours: per-tenant rate limits and statement_timeout. Big tenants may get their own database.</li><li>Scale: hash-partition or shard by tenant_id (Citus). Cross-tenant analytics goes to a warehouse.</li></ul>'],
  ['Payments / money ledger', '<ul><li>Double-entry: an immutable <code>ledger_entries</code> table (debit and credit sum to zero per transaction); balances derived or cached.</li><li>Integer minor units plus a currency; never float.</li><li>Idempotency keys (unique) on every externally triggered write; store the response.</li><li>Lock the account rows in a consistent order (FOR UPDATE) or use SERIALIZABLE with retries; no deleting — only reversing entries.</li></ul>'],
  ['Job queue / outbox', '<ul><li>SKIP LOCKED workers, a partial index on queued jobs, attempts and backoff, stale-lock recovery.</li><li>Outbox: write the event row in the same transaction as the business change; a relay publishes it to Kafka (or Debezium tails the WAL).</li><li>Move to a dedicated broker when you need very high throughput, fan-out, or replay by many consumers.</li></ul>'],
  ['Activity feed / audit log (append-heavy)', '<ul><li>Append-only table, time-partitioned (monthly), BRIN on the timestamp, retention by dropping partitions.</li><li>Keyset pagination on <code>(created_at, id)</code>.</li><li>Fan-out on write vs on read, and caching feeds for heavy users.</li></ul>'],
  ['Booking / reservations', '<ul><li><code>tstzrange</code> plus an exclusion constraint (<code>EXCLUDE USING gist (resource_id WITH =, during WITH &amp;&amp;)</code>). Race-free by construction.</li><li>Holds with an expiry (<code>expires_at</code>), cleaned by a job; payment confirmation turns a hold into a booking.</li></ul>'],
  ['Search', '<ul><li>Start with built-in full-text search (a tsvector GIN index, ts_rank) and pg_trgm for fuzzy or substring matching.</li><li>Move to OpenSearch or Elasticsearch for relevance tuning, facets at scale, or multi-language analyzers, fed by CDC from Postgres.</li></ul>'],
  ['URL shortener / key-value lookups', '<ul><li>A single table with a primary key on the code. Reads are PK lookups — cache them (Redis or a CDN) since they’re immutable.</li><li>Generating ids: a sequence encoded as base62, or random codes with a unique constraint and retry on collision.</li><li>Click counts: don’t update the link row per click (hot rows). Append to a clicks table or a queue and aggregate.</li></ul>'],
  ['“It needs to handle 10× traffic”', '<ul><li>Measure first: which queries and which resource (CPU, I/O, connections, locks)?</li><li>Then the ladder: queries and indexes → scale up → pooling → caching → read replicas (mind the lag) → partitioning → offloading workloads → sharding.</li><li>Name the specific bottleneck each step addresses.</li></ul>'],
].map(([q, a]) => `<details class="card"><summary>${q}</summary><div class="ans">${a}</div></details>`).join('')}
</div>
${INTERVIEW(`<p>Phrases that land well: “Postgres gets us surprisingly far here — a single well-indexed primary with replicas typically handles thousands of transactions per second.” “The access pattern is X, so the index is (a, b).” “The concurrency hazard is Y, and the database enforces it with Z.” “We’d shard only when writes exceed one primary, and here’s the key we’d shard on.”</p>`)}
`,
},
]});

/* ═══════════════════════ MODULE 10 — Beyond the lab ═══════════════════════ */
modules.push({ title: 'Beyond the lab', lessons: [
{
  id: 'local', title: 'Run it on your own Postgres', minutes: 10,
  lede: 'The console has a switch: <b>In-browser</b> works anywhere, including your phone. <b>Your Postgres</b> runs every lesson against a real server on your laptop, with several connections at once.',
  body: `
${TABLE(['', 'In-browser (default)', 'Your Postgres'], [
  ['Where it runs', 'PGlite: PostgreSQL 18 compiled to WebAssembly, inside this tab', 'Your own PostgreSQL server, through a small local helper (the bridge)'],
  ['Connections', 'One', 'Sessions <b>A</b>, <b>B</b>, <b>C</b> in the console, plus live two- and three-session scenarios'],
  ['Autovacuum, timeouts', 'None; you run VACUUM/ANALYZE yourself; Stop restarts the engine', 'Real autovacuum; <code>statement_timeout</code> works; Stop cancels the query (<code>pg_cancel_backend</code>)'],
  ['Needs', 'Nothing', 'PostgreSQL + Node.js on the computer you’re using'],
])}
<h2>1 · Install PostgreSQL 18</h2>
<ul>
  <li><strong>Windows:</strong> the installer from <a href="https://www.postgresql.org/download/windows/" target="_blank" rel="noopener">postgresql.org/download/windows</a> (skip Stack Builder).</li>
  <li><strong>macOS:</strong> <a href="https://postgresapp.com" target="_blank" rel="noopener">Postgres.app</a>, or <code>brew install postgresql@18</code>.</li>
  <li><strong>Docker</strong> (any OS): <code>docker run --name pglab -e POSTGRES_PASSWORD=… -p 5432:5432 -d postgres:18 -c shared_preload_libraries=pg_stat_statements</code></li>
</ul>
<h2>2 · Let tools connect without typing the password</h2>
<p>Create a <em>pgpass</em> file with one line, <code>localhost:5432:*:postgres:YOUR_PASSWORD</code>. psql, pg_dump and the bridge all read it. On Windows it lives at <code>%APPDATA%\\postgresql\\pgpass.conf</code>; on macOS and Linux at <code>~/.pgpass</code> (then <code>chmod 600 ~/.pgpass</code>). Setting the <code>PGPASSWORD</code> environment variable also works.</p>
<h2>3 · Start the bridge</h2>
<pre class="sql" data-norun data-label="Terminal, in the learn-pg folder">cd bridge
npm install      # first time only
npm start</pre>
<p>It listens on <code>127.0.0.1:8787</code> only, creates a database named <b>pglab</b>, and prints two links:</p>
<ul>
  <li><b>http://localhost:8787</b> serves this lab straight from your folder, already paired.</li>
  <li>The <b>pairing link</b> (<code>…/learn-pg/#pair=…</code>) pairs the GitHub Pages site in this browser. You only need to do it once; the token is kept in <code>bridge/.pglab-token</code>.</li>
</ul>
<p>Then flip the console switch to <b>Your Postgres</b> and press <b>Load the dataset</b> (about 20 seconds). Chrome may ask to let the site “access other apps and services on this device” — that’s the page talking to the bridge on 127.0.0.1. Allow it.</p>
${WARN(`<p>The bridge runs any SQL it’s sent against your server, as the user in your pgpass file. That’s why it only listens on 127.0.0.1, only answers pages it knows (the GitHub Pages site, localhost, or a file opened from disk), and requires the pairing token. Keep the token private, and stop the bridge (Ctrl+C) when you’re not studying.</p>`)}
<h2>4 · What to try first</h2>
<ul>
  <li><b>A real lock wait:</b> in session A, <code>BEGIN; UPDATE products SET stock = stock - 1 WHERE id = 7;</code>. Press <b>B</b> (or Alt+2) and run the same UPDATE: it waits, and the console shows who is blocking it. Go back to A and COMMIT.</li>
  <li><b>The scenario players</b> in Module 6 have a <b>Live</b> button: the deadlock, the SERIALIZABLE failure and the migration outage all happen for real, with real PIDs.</li>
  <li><b>Autovacuum:</b> update 30% of a table, then watch <code>n_dead_tup</code> and <code>last_autovacuum</code> in <code>pg_stat_user_tables</code> over a minute.</li>
  <li><b>pg_stat_statements:</b> enable it once with <code>ALTER SYSTEM SET shared_preload_libraries = 'pg_stat_statements';</code> and restart the server (Windows: <code>Restart-Service postgresql-x64-18</code> in an admin PowerShell).</li>
</ul>
<h2>5 · Plain psql, too</h2>
<p>Real terminals are worth practicing in: <code>psql -h localhost -U postgres -d pglab</code> connects to the same database the lab uses. Open two or three terminals and replay the Module 6 scenarios by hand, then diagnose them with <code>SELECT pid, pg_blocking_pids(pid), state, wait_event, query FROM pg_stat_activity;</code>. To load the dataset into another database without the bridge, use <code>psql -v ON_ERROR_STOP=1 -f seed.sql</code>.</p>
${JOB(`<p>Get used to the real-server tools too: <code>\\watch</code>, <code>\\copy</code>, <code>pg_dump -Fc</code> with <code>pg_restore</code>, <code>pg_stat_activity</code> under load (try <code>pgbench -i -s 50</code>, then <code>pgbench -c 20 -T 60</code>), and <code>ALTER SYSTEM</code> with <code>SELECT pg_reload_conf()</code>.</p>`)}
`,
},
{
  id: 'resources', title: 'Vetted resources, and what to read when', minutes: 6,
  lede: 'A short list, chosen for quality, not completeness. Each one is the best source on its topic.',
  body: `
${TABLE(['Resource', 'Best for', 'When'], [
  ['<a href="https://www.postgresql.org/docs/current/" target="_blank" rel="noopener">PostgreSQL documentation</a> — especially <a href="https://www.postgresql.org/docs/current/using-explain.html" target="_blank" rel="noopener">Using EXPLAIN</a>, <a href="https://www.postgresql.org/docs/current/mvcc.html" target="_blank" rel="noopener">Concurrency Control</a>, <a href="https://www.postgresql.org/docs/current/indexes.html" target="_blank" rel="noopener">Indexes</a>, <a href="https://www.postgresql.org/docs/current/explicit-locking.html" target="_blank" rel="noopener">Explicit Locking</a>', 'The authoritative reference. Unusually well written.', 'Alongside Modules 3–6'],
  ['<a href="https://use-the-index-luke.com/" target="_blank" rel="noopener">Use The Index, Luke!</a> (Markus Winand)', 'The best explanation of B-tree indexing for developers.', 'Module 5, then keep it'],
  ['<a href="https://postgrespro.com/community/books/internals" target="_blank" rel="noopener">PostgreSQL 14 Internals</a> (Egor Rogov, free PDF)', 'MVCC, VACUUM, the buffer cache, WAL, locks and the planner, in depth.', 'After Module 3, when you want the “why”'],
  ['<a href="https://www.interdb.jp/pg/" target="_blank" rel="noopener">The Internals of PostgreSQL</a> (Hironobu Suzuki)', 'A free online book with excellent diagrams of storage, MVCC and WAL.', 'Pairs with Rogov'],
  ['<a href="https://wiki.postgresql.org/wiki/Don%27t_Do_This" target="_blank" rel="noopener">Wiki: Don’t Do This</a>', 'A short list of footguns (timestamp, money, NOT IN, varchar(n)…).', 'Now — it takes 15 minutes'],
  ['<a href="https://pgexercises.com/" target="_blank" rel="noopener">PostgreSQL Exercises</a>', 'More SQL drills on a small schema.', 'Extra reps for Module 2 and 9'],
  ['<a href="https://modern-sql.com/" target="_blank" rel="noopener">modern-sql.com</a>', 'Window functions, LATERAL, FILTER, MERGE — what’s standard and what each database supports.', 'Module 2'],
  ['<a href="https://explain.dalibo.com/" target="_blank" rel="noopener">explain.dalibo.com</a> / <a href="https://explain.depesz.com/" target="_blank" rel="noopener">explain.depesz.com</a>', 'Visualize real EXPLAIN (ANALYZE, BUFFERS) output.', 'Whenever you debug a plan at work'],
  ['<a href="https://github.com/ankane/strong_migrations" target="_blank" rel="noopener">strong_migrations</a> and <a href="https://squawkhq.com/" target="_blank" rel="noopener">squawk</a>', 'Catalogs of dangerous migrations and their safe equivalents.', 'Module 8, before your next migration'],
  ['<a href="https://dataintensive.net/" target="_blank" rel="noopener">Designing Data-Intensive Applications</a> (Kleppmann) — chapters 3, 5, 7', 'Storage engines, replication and transactions, beyond any single database. The system-design classic.', 'Interview prep, alongside Modules 6–8'],
  ['<a href="https://15445.courses.cs.cmu.edu/" target="_blank" rel="noopener">CMU 15-445 Database Systems</a> (Andy Pavlo, lectures free on YouTube)', 'How databases work inside: buffer pools, indexes, joins, concurrency control, recovery.', 'If you enjoyed Module 3 and want the full picture'],
  ['<a href="https://pganalyze.com/blog" target="_blank" rel="noopener">pganalyze blog</a> (“5mins of Postgres”)', 'Short, practical deep dives on real-world Postgres behavior and new releases.', 'Ongoing, 10 minutes a week'],
])}
<h2>A four-week plan</h2>
${TABLE(['Week', 'Do', 'Outcome'], [
  ['1', 'Modules 1–2 plus pgexercises; skim “Don’t Do This”.', 'Fast, correct SQL including windows and CTEs'],
  ['2', 'Modules 3–5, with Use The Index, Luke! alongside.', 'You can read any EXPLAIN and design the index'],
  ['3', 'Modules 6–7; run the two-terminal experiments locally; DDIA chapter 7.', 'Confident on isolation, locking and constraints'],
  ['4', 'Module 8, then Module 9 twice (timed); explain each concept card out loud.', 'Interview-ready, and on-call-ready'],
])}
`,
},
]});
})();
