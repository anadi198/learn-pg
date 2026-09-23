/* Postgres Lab — curriculum, part 1 (helpers + modules 1–5). */
(() => {
'use strict';
const escH = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const quizzes = {}; const sims = {};
const S = (sql, o = {}) => `<pre class="sql"${o.norun ? ' data-norun' : ''}${o.label ? ` data-label="${o.label}"` : ''}>${escH(sql.trim())}</pre>`;
const QUIZ = (id, q, options, answer, why) => { quizzes[id] = { id, q, options, answer, why }; return `<div class="quiz" data-quiz="${id}"></div>`; };
const SIM = (...ids) => `<div class="sim" data-sim="${ids.join(',')}"></div>`;
const CALL = (kind, title, html) => `<div class="callout ${kind}"><b>${title}</b>${html}</div>`;
const INTERVIEW = (html) => CALL('interview', 'In interviews', html);
const JOB = (html) => CALL('job', 'In practice', html);
const WARN = (html) => CALL('warn', 'Watch out', html);
const LAB = (html) => CALL('lab', 'About this lab', html);
const TABLE = (head, rows) => `<div class="tablewrap"><table class="t"><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";
// Setup helper: drop every index on a table that isn't backing a constraint (PK/UNIQUE/EXCLUDE).
const DROP_EXTRA = (t) => `DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT i.indexrelid::regclass AS idx FROM pg_index i LEFT JOIN pg_constraint c ON c.conindid = i.indexrelid
           WHERE i.indrelid = '${t}'::regclass AND c.oid IS NULL LOOP
    EXECUTE 'DROP INDEX ' || r.idx;
  END LOOP; END $$;`;
// Plan helpers for checkers
const seqOn = (nodes, rel) => nodes.some((n) => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === rel);
const sorts = (nodes) => nodes.filter((n) => /Sort/.test(n['Node Type']));
const idxUsed = (nodes) => [...new Set(nodes.filter((n) => n['Index Name']).map((n) => n['Index Name']))];
const H = { escH, S, QUIZ, SIM, CALL, INTERVIEW, JOB, WARN, LAB, TABLE, lit, DROP_EXTRA, seqOn, sorts, idxUsed, quizzes, sims };
window.PGLAB_H = H;

const modules = [];

/* ═══════════════════════ MODULE 1 — Start here ═══════════════════════ */
modules.push({ title: 'Start here', lessons: [
{
  id: 'expectations', title: 'The map: what this course covers', minutes: 8,
  lede: 'Writing a query that works is the easy part. Getting good at Postgres means <em>predicting</em> what it will do with that query — which plan it picks, which lock it takes, what happens when two requests race — and designing so the answer is boring.',
  body: `
<p>Someone looks at a slow page and says “that’s a sequential scan on a 40 GB table, because the planner thinks the filter matches half the rows — the stats are stale.” Nothing magic happened there: they knew where to look. This course builds that instinct hands-on, on a real Postgres with realistic data.</p>
<p>Here’s the map. <b>Core</b> is what you’ll use constantly, <b>Practical</b> is what matters once Postgres runs something real, and <b>Deep dive</b> is the internals that make everything else click.</p>
<div class="expect">
  <section><h4>SQL fluency <span class="lvl must">Core</span></h4><ul><li>Window functions, CTEs, recursive queries, LATERAL</li><li>NULL semantics, anti-joins, the NOT IN trap</li><li>Upserts, RETURNING, set-based updates</li></ul><a href="#nulls">Module 2 →</a></section>
  <section><h4>Reading EXPLAIN ANALYZE <span class="lvl must">Core</span></h4><ul><li>Scan and join types, and when each wins</li><li>Estimated vs actual rows — the #1 clue</li><li>Buffers, loops, spills to disk</li></ul><a href="#explain">Module 4 →</a></section>
  <section><h4>Index design <span class="lvl must">Core</span></h4><ul><li>Composite column order, sort + LIMIT</li><li>Partial, expression, covering indexes</li><li>GIN / BRIN / GiST, and what indexes cost</li></ul><a href="#composite">Module 5 →</a></section>
  <section><h4>Transactions &amp; concurrency <span class="lvl must">Core</span></h4><ul><li>MVCC, isolation levels, anomalies</li><li>Row and table locks, deadlocks, SKIP LOCKED</li><li>Lost updates, idempotency, retries</li></ul><a href="#isolation">Module 6 →</a></section>
  <section><h4>Schema design <span class="lvl must">Core</span></h4><ul><li>Types and keys (bigint vs UUID, money, time)</li><li>Constraints as correctness guarantees</li><li>Normalization trade-offs, partitioning</li></ul><a href="#types">Module 7 →</a></section>
  <section><h4>Running it in production <span class="lvl should">Practical</span></h4><ul><li>pg_stat_statements, the slow-query playbook</li><li>Pooling, timeouts, zero-downtime migrations</li><li>Replication lag, backups/PITR, vacuum health</li></ul><a href="#slow-queries">Module 8 →</a></section>
  <section><h4>Internals <span class="lvl bonus">Deep dive</span></h4><ul><li>Pages, tuples, the heap, TOAST</li><li>Dead tuples, VACUUM, HOT, wraparound</li><li>The planner’s cost model</li></ul><a href="#storage">Module 3 →</a></section>
  <section><h4>Interview practice <span class="lvl should">Practical</span></h4><ul><li>Classic SQL puzzles, timed</li><li>Concept questions with model answers</li><li>Postgres in system-design rounds</li></ul><a href="#puzzles">Module 9 →</a></section>
</div>
<h2>If you’re preparing for interviews</h2>
<p>Postgres shows up in backend interviews in four ways. Module 9 has practice for each.</p>
${TABLE(['Round', 'Typical ask', 'What a strong answer sounds like'], [
  ['SQL / live coding', 'Top-N per group, running totals, dedupe, gaps &amp; islands, “customers who never…”', 'Correct first, then: ties, NULLs, and which index would make it fast.'],
  ['System design', '“Store X, query Y at Z QPS.”', 'Schema + access patterns + indexes, then where one Postgres stops scaling and what comes next.'],
  ['Deep dive / debugging', '“This query got slow overnight.”', 'A method: pg_stat_statements → EXPLAIN (ANALYZE, BUFFERS) → estimate vs actual → fix → verify.'],
  ['Experience', '“Tell me about a database incident.”', 'A specific story: a migration stuck in the lock queue, bloat from a stuck transaction, pool exhaustion, a plan flip.'],
])}
<h2>How to use this lab</h2>
<ul>
  <li><strong>The console on the right is a real PostgreSQL 18</strong>, compiled to WebAssembly and running in this tab. Nothing is simulated except where a lesson says so.</li>
  <li>Every SQL block has <b>Run ▸</b>. Edit freely — you can’t break anything that <b>Reset ▾</b> can’t fix.</li>
  <li>Exercises are checked against the live database, so your answer must actually work, not match a string.</li>
  <li>Press <b>Save snapshot</b> to keep the tables and indexes you create across reloads.</li>
</ul>
${LAB(`<p>The console has two engines. <b>In-browser</b> (the default) works anywhere, including phones, but has one connection: no autovacuum, no parallel query, and no second session for lock experiments, so concurrency scenarios replay recorded output. Its timings are roughly 2–4× slower than native Postgres, but the <em>ratios</em> between plans are what matter. <b>Your Postgres</b> connects to a real server on your laptop, with sessions A, B and C and live scenarios. <a href="#local">Module 10</a> shows the two-minute setup.</p>`)}
${QUIZ('q-lab-limits', 'Which of these can this in-browser lab <em>not</em> show you directly?', ['A query switching from Seq Scan to Index Scan after you add an index', 'Two sessions blocking each other on a row lock', 'Dead row versions left behind by an UPDATE', 'The planner mis-estimating rows because of stale statistics'], 1, 'The in-browser engine has a single connection, so real lock waits between sessions can’t happen there (switch the console to “Your Postgres” for that). Everything else is real, including dead tuples (you’ll look at them with <code>pageinspect</code>) and stale statistics (with no autovacuum, <em>you</em> are the one who runs ANALYZE).')}
`,
},
{
  id: 'meet-shop', title: 'Meet the shop database', minutes: 12,
  lede: 'Every lesson uses one realistic e-commerce schema with about 2.35 million rows. It’s big enough that a bad plan hurts and a good index is obvious.',
  body: `
<div class="schema">
  <div class="tbl"><h5>customers <span data-count="customers">…</span></h5><ul>
    <li class="pk"><b>id</b><i>bigint identity</i></li><li><b>email</b><i>text · unique</i></li><li><b>full_name</b><i>text</i></li>
    <li><b>country</b><i>char(2)</i></li><li><b>city</b><i>text</i></li><li><b>tier</b><i>free|pro|enterprise</i></li>
    <li><b>marketing_opt_in</b><i>bool</i></li><li><b>signup_at</b><i>timestamptz</i></li><li><b>deleted_at</b><i>timestamptz · null</i></li></ul></div>
  <div class="tbl"><h5>orders <span data-count="orders">…</span></h5><ul>
    <li class="pk"><b>id</b><i>bigint identity</i></li><li class="fk"><b>customer_id</b><i>→ customers</i></li>
    <li><b>status</b><i>6 values</i></li><li><b>created_at</b><i>timestamptz</i></li><li><b>total_cents</b><i>int</i></li>
    <li><b>shipping_country</b><i>char(2)</i></li><li><b>coupon_code</b><i>text · null</i></li></ul></div>
  <div class="tbl"><h5>order_items <span data-count="order_items">…</span></h5><ul>
    <li class="pk fk"><b>order_id</b><i>→ orders · pk</i></li><li class="pk fk"><b>product_id</b><i>→ products · pk</i></li>
    <li><b>quantity</b><i>int</i></li><li><b>unit_price_cents</b><i>int</i></li></ul></div>
  <div class="tbl"><h5>products <span data-count="products">…</span></h5><ul>
    <li class="pk"><b>id</b><i>bigint identity</i></li><li><b>sku</b><i>text · unique</i></li><li><b>name</b><i>text</i></li>
    <li><b>category</b><i>8 values</i></li><li><b>price_cents</b><i>int</i></li><li><b>stock</b><i>int ≥ 0</i></li>
    <li><b>attributes</b><i>jsonb</i></li><li><b>tags</b><i>text[]</i></li><li><b>created_at</b><i>timestamptz</i></li></ul></div>
  <div class="tbl"><h5>events <span data-count="events">…</span></h5><ul>
    <li class="pk"><b>id</b><i>bigint identity</i></li><li class="fk"><b>customer_id</b><i>→ customers · null</i></li>
    <li><b>event_type</b><i>5 values</i></li><li><b>occurred_at</b><i>timestamptz</i></li><li><b>payload</b><i>jsonb</i></li></ul></div>
  <div class="tbl"><h5>reviews <span data-count="reviews">…</span></h5><ul>
    <li class="pk"><b>id</b><i>bigint identity</i></li><li class="fk"><b>product_id</b><i>→ products</i></li><li class="fk"><b>customer_id</b><i>→ customers</i></li>
    <li><b>rating</b><i>1–5</i></li><li><b>title</b><i>text</i></li><li><b>body</b><i>text</i></li><li><b>created_at</b><i>timestamptz</i></li></ul></div>
  <div class="tbl"><h5>employees <span data-count="employees">…</span></h5><ul>
    <li class="pk"><b>id</b><i>int</i></li><li><b>full_name</b><i>text</i></li><li><b>department</b><i>text</i></li><li><b>title</b><i>text</i></li>
    <li class="fk"><b>manager_id</b><i>→ employees</i></li><li><b>salary</b><i>int</i></li><li><b>hired_at</b><i>date</i></li></ul></div>
</div>
<p>A few facts about the data that later lessons rely on:</p>
<ul>
  <li><strong>Skew.</strong> Low customer ids are the oldest and heaviest buyers — customer 1 has well over a thousand orders, a typical customer has a handful. Real data is skewed like this, and it’s why one plan can’t fit every parameter.</li>
  <li><strong>Time order.</strong> <code>orders</code>, <code>customers</code>, <code>events</code> and <code>reviews</code> were inserted in time order, so their ids and timestamps both grow with position in the table. That matters for BRIN indexes and statistics later.</li>
  <li><strong>Anonymous events.</strong> A quarter of <code>events</code> have <code>customer_id IS NULL</code>. That sets up a classic NULL trap.</li>
  <li><strong>Only the obvious indexes exist:</strong> primary keys and unique constraints. <em>No foreign-key column is indexed.</em> That’s deliberate: you’ll feel the pain first, then fix it.</li>
</ul>
<h2>psql survival kit</h2>
<p>psql’s backslash commands are how you explore a database. They work in this console too. Start with the table list (<code>+</code> adds sizes) and one table’s structure:</p>
${S(`\\dt+
\\d orders`)}
<p><code>\\d</code> shows columns, then indexes, constraints and foreign keys in both directions. It’s the fastest way to answer “what is this table and how is it connected?”</p>
${S(`\\di
\\x on
SELECT * FROM products WHERE id = 1;
\\x off`)}
<p><code>\\x</code> switches to expanded output, one column per line. Use it for wide rows. <code>TABLE products;</code> is shorthand for <code>SELECT * FROM products;</code>. Add a LIMIT on big tables:</p>
${S(`SELECT id, customer_id, status, created_at, total_cents
FROM orders
ORDER BY id DESC
LIMIT 5;`)}
${JOB(`<p>On a real server you connect with <code>psql "postgres://user@host:5432/db"</code>. Beyond the commands above, you’ll use <code>\\timing</code> (show how long each statement took), <code>\\e</code> (open the query in your editor), <code>\\copy</code> (move CSV data between the server and your laptop), and <code>\\watch 2</code> (re-run a query every 2 seconds — great for watching a migration). Put <code>\\set ON_ERROR_STOP on</code> at the top of scripts so they stop at the first error.</p>`)}
`,
  exercises: [
    { id: 'm1-status', title: 'Orders by status', check: { type: 'result' },
      prompt: '<p>How many orders are there in each status? Return two columns, <code>status</code> and the count. Row order doesn’t matter.</p>',
      starter: 'SELECT ', hint: '<p>GROUP BY the column you want one row per value of.</p>',
      solution: `SELECT status, count(*) FROM orders GROUP BY status;` },
    { id: 'm1-countries', title: 'Top 5 countries by customers', check: { type: 'result', ordered: true },
      prompt: '<p>Which 5 countries have the most customers? Return <code>country</code> and the number of customers, biggest first.</p>',
      hint: '<p><code>ORDER BY count(*) DESC LIMIT 5</code>. You can also ORDER BY a column alias.</p>',
      solution: `SELECT country, count(*) AS customers FROM customers GROUP BY country ORDER BY customers DESC LIMIT 5;` },
    { id: 'm1-spender', title: 'The biggest spender', check: { type: 'result', ordered: true },
      prompt: '<p>Which customer has the highest lifetime spend on <em>delivered</em> orders? Return <code>id</code>, <code>full_name</code> and the spend in dollars as a numeric rounded to 2 decimals.</p>',
      hint: '<p>Join customers to orders, filter on status, group by the customer, and sum <code>total_cents</code>. Divide by <code>100.0</code>, not <code>100</code> — integer division truncates.</p>',
      solution: `SELECT c.id, c.full_name, round(sum(o.total_cents) / 100.0, 2) AS spend
FROM customers c
JOIN orders o ON o.customer_id = c.id
WHERE o.status = 'delivered'
GROUP BY c.id
ORDER BY spend DESC
LIMIT 1;`,
      explain: 'Notice <code>GROUP BY c.id</code> alone is enough to also select <code>c.full_name</code>: Postgres knows <code>id</code> is the primary key, so every other column of <code>c</code> is functionally dependent on it.' },
  ],
},
]});

/* ═══════════════════════ MODULE 2 — SQL beyond joins ═══════════════════════ */
modules.push({ title: 'SQL beyond joins', lessons: [
{
  id: 'nulls', title: 'NULL, three-valued logic and anti-joins', minutes: 14,
  lede: 'NULL means “unknown”, and unknown is contagious. Most wrong-answer bugs in SQL come from a NULL somewhere you weren’t looking.',
  body: `
<p>SQL logic has three values: TRUE, FALSE and UNKNOWN. Any comparison with NULL is UNKNOWN, including <code>NULL = NULL</code>. <code>WHERE</code> keeps only rows where the condition is TRUE, so UNKNOWN rows quietly disappear.</p>
${S(`SELECT NULL = NULL             AS equals,
       NULL <> 1               AS not_equals,
       NULL IS NULL            AS is_null,
       1 IS DISTINCT FROM NULL AS distinct_from,
       NULL IS NOT DISTINCT FROM NULL AS same;`)}
<p><code>IS [NOT] DISTINCT FROM</code> is the NULL-safe comparison. It’s especially handy in change-detection updates: <code>WHERE old.col IS DISTINCT FROM new.col</code>.</p>
<h2>Aggregates skip NULLs</h2>
<p><code>count(*)</code> counts rows. <code>count(col)</code> counts non-NULL values. <code>sum</code>, <code>avg</code>, <code>min</code> and <code>max</code> ignore NULLs, and return NULL (not 0) when every input is NULL.</p>
${S(`SELECT count(*)                    AS orders,
       count(coupon_code)          AS with_coupon,
       count(DISTINCT coupon_code) AS distinct_codes,
       sum(total_cents) FILTER (WHERE false) AS sum_of_nothing,
       coalesce(sum(total_cents) FILTER (WHERE false), 0) AS coalesced
FROM orders;`)}
<p>Two tools you’ll use constantly: <code>COALESCE(a, b, …)</code> returns the first non-NULL argument, and <code>NULLIF(a, b)</code> returns NULL when <code>a = b</code>. The classic divide-by-zero guard is <code>x / NULLIF(y, 0)</code>.</p>
<h2>The NOT IN trap (with real data)</h2>
<p>Question: how many customers were inactive during the first week of 2026 — no events at all? The obvious query:</p>
${S(`-- events.customer_id is NULL for anonymous visitors
SELECT count(*) FROM customers
WHERE id NOT IN (SELECT customer_id FROM events WHERE occurred_at < '2026-01-08');`)}
<p>It returns <strong>0</strong>. Here’s why: <code>id NOT IN (1, 2, NULL)</code> means <code>id &lt;&gt; 1 AND id &lt;&gt; 2 AND id &lt;&gt; NULL</code>, and the last part is UNKNOWN for every id. One NULL in the subquery makes <code>NOT IN</code> reject every row. Write anti-joins with <code>NOT EXISTS</code> instead:</p>
${S(`SELECT count(*) FROM customers c
WHERE NOT EXISTS (
  SELECT 1 FROM events e
  WHERE e.customer_id = c.id AND e.occurred_at < '2026-01-08'
);`)}
<p>Tens of thousands, not zero. Run it with <b>Explain ▸</b> and you’ll see a <strong>Hash Anti Join</strong>: the planner turns <code>NOT EXISTS</code> into a real anti-join algorithm. The <code>LEFT JOIN … WHERE e.id IS NULL</code> form is equivalent and gets the same plan.</p>
${WARN(`<p><code>NOT IN</code> is a performance trap too. Its NULL semantics block the anti-join rewrite, so Postgres checks each outer row against the subquery’s result: a hash table if it fits in <code>work_mem</code>, otherwise a <em>linear scan per row</em>. Over the whole events table that’s billions of comparisons — minutes, not milliseconds. (That’s why the demo above only looks at one week.)</p>`)}
${QUIZ('q-null-neq', 'Some rows have <code>x</code> NULL. What does <code>SELECT count(*) FROM t WHERE x &lt;&gt; 5</code> count?', ['Rows where x isn’t 5, including the NULL rows', 'Rows where x isn’t 5, excluding the NULL rows', 'It raises an error because of the NULLs'], 1, '<code>NULL &lt;&gt; 5</code> is UNKNOWN, so WHERE drops it. To include NULLs, write <code>x IS DISTINCT FROM 5</code>.')}
<h2>Sorting NULLs</h2>
<p>By default NULLs sort as if they were larger than every value: last in <code>ASC</code>, first in <code>DESC</code>. Override with <code>NULLS FIRST</code> or <code>NULLS LAST</code>. An index can only serve an <code>ORDER BY</code> if its NULL placement matches.</p>
${INTERVIEW(`<p>“Find customers without orders” is a warm-up question with a hidden test. Say <em>NOT EXISTS</em>, and say <em>why</em> not <code>NOT IN</code>. Mentioning that <code>count(col)</code> skips NULLs and that <code>avg</code> ignores them (so it isn’t “sum divided by row count”) signals you’ve debugged real reports.</p>`)}
`,
  exercises: [
    { id: 'm2-silent', title: 'Customers who didn’t search for two weeks', check: { type: 'result' },
      prompt: '<p>How many customers have <em>no</em> events of type <code>\'search\'</code> in the first two weeks of 2026 (<code>occurred_at &lt; \'2026-01-15\'</code>)? One row, one column.</p>',
      hint: '<p><code>NOT IN</code> returns 0 here because <code>events.customer_id</code> contains NULLs. Use <code>NOT EXISTS</code> (or a <code>LEFT JOIN … IS NULL</code>), and put both event filters <em>inside</em> the subquery.</p>',
      solution: `SELECT count(*) FROM customers c
WHERE NOT EXISTS (
  SELECT 1 FROM events e
  WHERE e.customer_id = c.id AND e.event_type = 'search' AND e.occurred_at < '2026-01-15'
);`,
      alts: [`SELECT count(*) FROM customers c LEFT JOIN events e ON e.customer_id = c.id AND e.event_type = 'search' AND e.occurred_at < '2026-01-15' WHERE e.id IS NULL;`],
      wrong: [`SELECT count(*) FROM customers WHERE id NOT IN (SELECT customer_id FROM events WHERE event_type = 'search' AND occurred_at < '2026-01-15');`,
        `SELECT count(*) FROM customers c LEFT JOIN events e ON e.customer_id = c.id WHERE e.id IS NULL AND e.event_type = 'search' AND e.occurred_at < '2026-01-15';`] },
    { id: 'm2-coupon', title: 'Coupon usage rate', check: { type: 'result' },
      prompt: '<p>What fraction of all orders used a coupon (<code>coupon_code</code> is not NULL)? Return one value rounded to 4 decimals, e.g. <code>0.1234</code>.</p>',
      hint: '<p><code>count(coupon_code)</code> counts only non-NULL values. Cast to numeric before dividing, then <code>round(…, 4)</code>.</p>',
      solution: `SELECT round(count(coupon_code)::numeric / count(*), 4) FROM orders;`,
      alts: [`SELECT round(avg((coupon_code IS NOT NULL)::int), 4) FROM orders;`] },
  ],
},
{
  id: 'aggregates', title: 'Aggregation power tools', minutes: 14,
  lede: 'GROUP BY is where reporting queries live. FILTER, HAVING, ordered-set aggregates and generate_series turn five queries into one.',
  body: `
<p>Order of evaluation, simplified: <code>FROM/JOIN → WHERE → GROUP BY → aggregates → HAVING → window functions → SELECT list → ORDER BY → LIMIT</code>. That’s why <code>WHERE</code> can’t reference an aggregate and <code>HAVING</code> can.</p>
<h2>FILTER: many conditional aggregates, one pass</h2>
${S(`SELECT shipping_country,
       count(*)                                     AS orders,
       count(*) FILTER (WHERE status = 'cancelled') AS cancelled,
       round(100.0 * count(*) FILTER (WHERE status = 'cancelled') / count(*), 1) AS cancel_pct
FROM orders
GROUP BY shipping_country
HAVING count(*) > 10000
ORDER BY cancel_pct DESC;`)}
<p><code>FILTER (WHERE …)</code> is Postgres’s cleaner spelling of <code>sum(CASE WHEN … THEN 1 ELSE 0 END)</code>. The table is scanned once, however many filtered aggregates you add.</p>
<h2>Time buckets and gap filling</h2>
<p><code>date_trunc('day' | 'week' | 'month', ts)</code> buckets timestamps. Days with no orders don’t appear in a GROUP BY, so charts get holes. Fix that by generating the calendar and LEFT JOINing to it:</p>
${S(`WITH daily AS (
  SELECT date_trunc('day', created_at) AS day, count(*) AS orders
  FROM orders
  WHERE created_at >= '2026-06-20' AND status = 'pending'
  GROUP BY 1
)
SELECT d::date AS day, coalesce(daily.orders, 0) AS pending_orders
FROM generate_series('2026-06-20'::date, '2026-06-30'::date, interval '1 day') d
LEFT JOIN daily ON daily.day = d
ORDER BY 1;`)}
<h2>Ordered-set aggregates and string aggregation</h2>
${S(`SELECT category,
       count(*) AS products,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY price_cents) / 100 AS median_price,
       mode() WITHIN GROUP (ORDER BY attributes->>'color')          AS most_common_color,
       string_agg(DISTINCT attributes->>'brand', ', ')              AS brands
FROM products
GROUP BY category
ORDER BY median_price DESC;`)}
<p><code>percentile_cont</code> interpolates between values, while <code>percentile_disc</code> returns an actual value from the set. <code>attributes->>'brand'</code> pulls a text value out of <code>jsonb</code> (Module 5 covers indexing jsonb).</p>
<h2>Subtotals with ROLLUP</h2>
${S(`SELECT tier, marketing_opt_in, count(*)
FROM customers
GROUP BY ROLLUP (tier, marketing_opt_in)
ORDER BY tier NULLS LAST, marketing_opt_in NULLS LAST;`)}
<p>The NULL rows are subtotals: per tier, then a grand total. <code>GROUPING SETS</code> and <code>CUBE</code> generalize this.</p>
${WARN(`<p><code>sum(a) / count(*)</code> on integers is <strong>integer division</strong>: 7 / 2 = 3. Multiply by <code>1.0</code> or cast to numeric first. <code>avg()</code> on integers already returns numeric.</p>`)}
${INTERVIEW(`<p>Expect “WHERE vs HAVING” and “why is my average wrong?” questions, and reports like “revenue by month with cancellation rate”. Reaching for <code>FILTER</code> instead of three self-joins shows you’ve written real reports.</p>`)}
`,
  exercises: [
    { id: 'm2-monthly', title: '2025 revenue and cancellations by month', check: { type: 'result', ordered: true },
      prompt: `<p>For orders created in calendar year 2025, return one row per month with:</p>
<ul><li><code>month</code> — from <code>date_trunc('month', created_at)</code></li><li><code>revenue</code> — sum of <code>total_cents</code> for <em>delivered or shipped</em> orders, in dollars (divide by 100.0)</li><li><code>cancelled</code> — how many orders in that month were cancelled</li></ul><p>Order by month.</p>`,
      hint: '<p>A single GROUP BY with two FILTERed aggregates. The WHERE clause is a half-open range: <code>created_at &gt;= \'2025-01-01\' AND created_at &lt; \'2026-01-01\'</code>.</p>',
      solution: `SELECT date_trunc('month', created_at) AS month,
       sum(total_cents) FILTER (WHERE status IN ('delivered', 'shipped')) / 100.0 AS revenue,
       count(*) FILTER (WHERE status = 'cancelled') AS cancelled
FROM orders
WHERE created_at >= '2025-01-01' AND created_at < '2026-01-01'
GROUP BY 1
ORDER BY 1;`,
      alts: [`SELECT date_trunc('month', created_at)::date, sum(CASE WHEN status IN ('delivered','shipped') THEN total_cents END) / 100.0, sum(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) FROM orders WHERE created_at >= '2025-01-01' AND created_at < '2026-01-01' GROUP BY 1 ORDER BY 1;`] },
    { id: 'm2-median', title: 'Median order value by tier', check: { type: 'result' },
      prompt: '<p>For each customer <code>tier</code>, return the median <code>total_cents</code> across all of that tier’s orders (any status), using <code>percentile_cont(0.5)</code>.</p>',
      hint: '<p>Join orders to customers, <code>GROUP BY c.tier</code>, then <code>percentile_cont(0.5) WITHIN GROUP (ORDER BY o.total_cents)</code>.</p>',
      solution: `SELECT c.tier, percentile_cont(0.5) WITHIN GROUP (ORDER BY o.total_cents) AS median_cents
FROM orders o JOIN customers c ON c.id = o.customer_id
GROUP BY c.tier;` },
    { id: 'm2-lowrated', title: 'Categories with too many bad reviews', check: { type: 'result' },
      prompt: '<p>Return every product <code>category</code> where more than 18% of its reviews are 1 or 2 stars. Columns: <code>category</code>, total <code>reviews</code>, and <code>low_pct</code> (percentage rounded to 1 decimal).</p>',
      hint: '<p>Join reviews to products. <code>count(*) FILTER (WHERE rating &lt;= 2)</code> gives the low count. Put the 18% condition in HAVING, and multiply by <code>100.0</code> before dividing.</p>',
      solution: `SELECT p.category, count(*) AS reviews,
       round(100.0 * count(*) FILTER (WHERE r.rating <= 2) / count(*), 1) AS low_pct
FROM reviews r JOIN products p ON p.id = r.product_id
GROUP BY p.category
HAVING count(*) FILTER (WHERE r.rating <= 2) > 0.18 * count(*);` },
  ],
},
{
  id: 'windows', title: 'Window functions', minutes: 18,
  lede: 'The single most-tested SQL topic in interviews. GROUP BY collapses rows. A window function keeps every row and adds a value computed over related rows.',
  body: `
<p>Syntax: <code>fn(…) OVER (PARTITION BY … ORDER BY … frame)</code>. <em>Partition</em> is the group, <em>order</em> sorts within it, and the <em>frame</em> is which rows around the current one count. Window functions run after WHERE, GROUP BY and HAVING, so you can window over aggregates. You can’t use them in WHERE — wrap the query in a subquery or CTE first.</p>
<h2>Ranking: ROW_NUMBER vs RANK vs DENSE_RANK</h2>
${S(`SELECT full_name, salary,
       row_number() OVER w AS row_number,
       rank()       OVER w AS rank,
       dense_rank() OVER w AS dense_rank
FROM employees
WHERE department = 'Support'
WINDOW w AS (ORDER BY salary DESC)
ORDER BY salary DESC
LIMIT 15;`)}
<p>Salaries are rounded to the nearest 1,000, so ties happen. On a tie, <code>row_number</code> picks an arbitrary order, <code>rank</code> leaves gaps (1, 2, 2, 4) and <code>dense_rank</code> doesn’t (1, 2, 2, 3). Pick deliberately: “top 3 salaries” usually means <code>dense_rank</code>, and “exactly one row per group” means <code>row_number</code>.</p>
${QUIZ('q-dense', 'Salaries in a department are 100, 100, 90. What is <code>dense_rank()</code> for 90 (ordered by salary DESC)?', ['1', '2', '3'], 1, 'dense_rank doesn’t skip: 100 → 1, 100 → 1, 90 → 2. <code>rank()</code> would give 3.')}
<h2>Top-N per group</h2>
${S(`SELECT * FROM (
  SELECT p.category, p.name, p.price_cents,
         row_number() OVER (PARTITION BY p.category ORDER BY p.price_cents DESC) AS rn
  FROM products p
) ranked
WHERE rn <= 2
ORDER BY category, rn;`)}
<h2>LAG, LEAD, running totals and moving averages</h2>
${S(`WITH daily AS (
  SELECT created_at::date AS day, sum(total_cents) / 100.0 AS revenue
  FROM orders
  WHERE created_at >= '2026-05-01' AND status NOT IN ('cancelled', 'refunded')
  GROUP BY 1
)
SELECT day, revenue,
       revenue - lag(revenue) OVER (ORDER BY day)                                AS vs_yesterday,
       round(avg(revenue) OVER (ORDER BY day ROWS BETWEEN 6 PRECEDING AND CURRENT ROW), 2) AS avg_7d,
       sum(revenue) OVER (ORDER BY day)                                          AS running_total,
       round(100 * revenue / sum(revenue) OVER (), 2)                            AS pct_of_period
FROM daily
ORDER BY day;`)}
${WARN(`<p><strong>The default frame bites.</strong> With <code>ORDER BY</code> in the window, the frame is <code>RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW</code>, which includes every <em>peer</em> of the current row (rows with the same sort value). A running total over non-unique dates jumps in steps. Write <code>ROWS BETWEEN …</code> explicitly when you mean physical rows. For the same reason <code>last_value()</code> “doesn’t work” until you widen the frame to <code>UNBOUNDED FOLLOWING</code>.</p>`)}
<p>Also worth knowing: <code>count(*) OVER ()</code> puts the total row count next to each paginated row, <code>ntile(4)</code> assigns quartiles, and <code>first_value</code> / <code>nth_value</code> pick rows inside the window.</p>
${INTERVIEW(`<p>These come up constantly: top-N per group, second-highest salary, dedupe keeping the latest row, running total, month-over-month change, consecutive-day streaks. Say out loud which ranking function you picked and what it does with ties — that’s often what’s being graded.</p>`)}
`,
  exercises: [
    { id: 'm2-top3', title: 'Top 3 salaries in each department', check: { type: 'result' },
      prompt: '<p>For each department, return everyone whose salary is among that department’s top 3 <em>distinct</em> salaries (ties included, so some departments return more than 3 people). Columns: <code>department</code>, <code>full_name</code>, <code>salary</code>.</p>',
      hint: '<p><code>dense_rank() OVER (PARTITION BY department ORDER BY salary DESC)</code> inside a subquery, then filter <code>&lt;= 3</code> outside.</p>',
      solution: `SELECT department, full_name, salary FROM (
  SELECT department, full_name, salary,
         dense_rank() OVER (PARTITION BY department ORDER BY salary DESC) AS r
  FROM employees
) s
WHERE r <= 3;` },
    { id: 'm2-running', title: 'Running revenue for June 2026', check: { type: 'result', ordered: true },
      prompt: '<p>For June 2026, return one row per day with <code>day</code> (a date), that day’s <code>revenue_cents</code> (sum of <code>total_cents</code> for orders that are <em>not</em> cancelled or refunded), and <code>running_cents</code>, the month-to-date running total. Order by day.</p>',
      hint: '<p>You can nest an aggregate inside a window: <code>sum(sum(total_cents)) OVER (ORDER BY created_at::date)</code>. Or aggregate in a CTE and window over it.</p>',
      solution: `SELECT created_at::date AS day,
       sum(total_cents) AS revenue_cents,
       sum(sum(total_cents)) OVER (ORDER BY created_at::date) AS running_cents
FROM orders
WHERE created_at >= '2026-06-01' AND created_at < '2026-07-01'
  AND status NOT IN ('cancelled', 'refunded')
GROUP BY 1
ORDER BY 1;` },
    { id: 'm2-gaps', title: 'Time between a customer’s orders', check: { type: 'result', ordered: true },
      prompt: '<p>For customer 42, list every order with <code>id</code>, <code>created_at</code>, and <code>gap</code>: the interval since that customer’s previous order (NULL for the first one). Just subtract the timestamps. Order by <code>created_at</code>.</p>',
      hint: '<p><code>created_at - lag(created_at) OVER (ORDER BY created_at)</code></p>',
      solution: `SELECT id, created_at, created_at - lag(created_at) OVER (ORDER BY created_at) AS gap
FROM orders
WHERE customer_id = 42
ORDER BY created_at;` },
  ],
},
{
  id: 'ctes', title: 'CTEs, recursion, LATERAL and DISTINCT ON', minutes: 16,
  lede: 'Four tools for questions that plain joins answer badly: naming steps, walking hierarchies, “for each row, run this subquery”, and “the first row of each group”.',
  body: `
<h2>CTEs are for readability (and no longer a fence)</h2>
<p><code>WITH name AS (…)</code> names a step. Since Postgres 12, a non-recursive CTE that’s referenced once and has no side effects is <em>inlined</em>: the planner optimizes through it as if you had written a subquery. Before 12 every CTE was an optimization fence, and plenty of blog posts still repeat that. Force either behavior with <code>AS MATERIALIZED</code> or <code>AS NOT MATERIALIZED</code>.</p>
<p>Data-modifying CTEs are a Postgres superpower. This moves rows atomically in one statement (try it — it rolls back):</p>
${S(`BEGIN;
CREATE TABLE events_archive (LIKE events);
WITH moved AS (
  DELETE FROM events
  WHERE occurred_at < '2026-01-02'
  RETURNING *
)
INSERT INTO events_archive SELECT * FROM moved;
SELECT count(*) AS archived FROM events_archive;
ROLLBACK;`)}
<h2>Recursive CTEs walk trees and graphs</h2>
<p>An anchor query, <code>UNION ALL</code>, and a recursive step that joins back to the CTE itself. This one walks from an employee up to the CEO:</p>
${S(`WITH RECURSIVE chain AS (
  SELECT id, full_name, title, manager_id, 0 AS depth
  FROM employees WHERE id = 777
  UNION ALL
  SELECT m.id, m.full_name, m.title, m.manager_id, c.depth + 1
  FROM employees m
  JOIN chain c ON m.id = c.manager_id
)
SELECT depth, full_name, title FROM chain ORDER BY depth;`)}
<p>Walking <em>down</em> is the same shape with the join flipped (<code>e.manager_id = t.id</code>). For graphs that can contain cycles, add a depth limit or use the <code>CYCLE</code> clause (Postgres 14+).</p>
<h2>LATERAL: a subquery that can see the outer row</h2>
<p>A LATERAL subquery runs once per outer row and can reference that row’s columns. It’s the natural fit for “top N per group”. With an index on the inner side, each lookup is cheap:</p>
${S(`SELECT c.id, c.full_name, o.id AS order_id, o.total_cents
FROM customers c
CROSS JOIN LATERAL (
  SELECT id, total_cents
  FROM orders
  WHERE customer_id = c.id
  ORDER BY total_cents DESC
  LIMIT 2
) o
WHERE c.id <= 3;`)}
<h2>DISTINCT ON: first row per group</h2>
<p>Postgres-specific and very handy. It keeps the first row for each distinct value of the <code>ON (…)</code> expressions, where “first” is defined by <code>ORDER BY</code>. The ORDER BY must start with those same expressions.</p>
${S(`SELECT DISTINCT ON (customer_id) customer_id, id AS order_id, created_at, status
FROM orders
WHERE customer_id <= 5
ORDER BY customer_id, created_at DESC;`)}
${INTERVIEW(`<p>“Model an org chart / category tree / threaded comments and query it” → recursive CTE, and mention that an index on the parent-id column makes each step cheap. Asked for “latest row per group”, you can offer three answers — <code>DISTINCT ON</code>, <code>row_number()</code>, <code>LATERAL … LIMIT 1</code> — and say LATERAL with an index wins when groups are few and rows per group are many.</p>`)}
`,
  exercises: [
    { id: 'm2-orgdepth', title: 'Engineering headcount by depth', check: { type: 'result', ordered: true },
      prompt: '<p>Employee 2 is the VP of Engineering. Count everyone in their reporting tree, grouped by depth: <code>depth</code> 1 means direct reports, 2 means reports of reports, and so on. Columns: <code>depth</code>, <code>headcount</code>, ordered by depth.</p>',
      hint: '<p>The anchor is <code>SELECT id, 1 AS depth FROM employees WHERE manager_id = 2</code>. The recursive step joins employees whose manager_id is in the tree, with depth + 1.</p>',
      solution: `WITH RECURSIVE tree AS (
  SELECT id, 1 AS depth FROM employees WHERE manager_id = 2
  UNION ALL
  SELECT e.id, t.depth + 1 FROM employees e JOIN tree t ON e.manager_id = t.id
)
SELECT depth, count(*) AS headcount FROM tree GROUP BY depth ORDER BY depth;` },
    { id: 'm2-latest-sg', title: 'Latest order per Singapore customer', check: { type: 'result' },
      prompt: '<p>For every customer whose <code>country</code> is <code>\'SG\'</code> and who has at least one order, return their most recent order: <code>customer_id</code>, <code>order_id</code>, <code>created_at</code>. Use DISTINCT ON.</p>',
      hint: '<p><code>SELECT DISTINCT ON (o.customer_id) …</code> with <code>ORDER BY o.customer_id, o.created_at DESC</code>. Join to customers to filter the country.</p>',
      solution: `SELECT DISTINCT ON (o.customer_id) o.customer_id, o.id AS order_id, o.created_at
FROM orders o JOIN customers c ON c.id = o.customer_id
WHERE c.country = 'SG'
ORDER BY o.customer_id, o.created_at DESC;`,
      alts: [`SELECT customer_id, id, created_at FROM (SELECT o.*, row_number() OVER (PARTITION BY o.customer_id ORDER BY o.created_at DESC) rn FROM orders o JOIN customers c ON c.id = o.customer_id WHERE c.country = 'SG') x WHERE rn = 1;`] },
    { id: 'm2-lateral', title: 'Three biggest orders per enterprise customer in Japan', check: { type: 'result' },
      prompt: '<p>For each <code>enterprise</code>-tier customer in Japan (<code>country = \'JP\'</code>), return their 3 largest orders by <code>total_cents</code>. Break ties by the lower order id. Columns: <code>customer_id</code>, <code>order_id</code>, <code>total_cents</code>. Use LATERAL.</p><p style="color:var(--ink-3)">Expect a second or two for now: with no index on <code>orders.customer_id</code> yet, each LATERAL probe scans every order. Module 4 fixes that — come back and compare.</p>',
      hint: '<p><code>FROM customers c CROSS JOIN LATERAL (SELECT … FROM orders WHERE customer_id = c.id ORDER BY total_cents DESC, id LIMIT 3) o</code></p>',
      solution: `SELECT c.id AS customer_id, o.id AS order_id, o.total_cents
FROM customers c
CROSS JOIN LATERAL (
  SELECT id, total_cents FROM orders
  WHERE customer_id = c.id
  ORDER BY total_cents DESC, id
  LIMIT 3
) o
WHERE c.tier = 'enterprise' AND c.country = 'JP';`,
      alts: [`SELECT customer_id, id, total_cents FROM (SELECT o.customer_id, o.id, o.total_cents, row_number() OVER (PARTITION BY o.customer_id ORDER BY o.total_cents DESC, o.id) rn FROM orders o JOIN customers c ON c.id = o.customer_id WHERE c.tier = 'enterprise' AND c.country = 'JP') x WHERE rn <= 3;`] },
  ],
},
{
  id: 'writes', title: 'Writing data: RETURNING, upserts and MERGE', minutes: 14,
  lede: 'Set-based writes are faster and safer than read-modify-write loops in application code. They’re also where most concurrency bugs are avoided — or created.',
  body: `
<p>To practice writes without consequences, wrap them in a transaction and roll back. DDL is transactional in Postgres too, which most databases can’t say.</p>
${S(`BEGIN;
INSERT INTO products (sku, name, category, price_cents, stock, created_at)
VALUES ('LAB-000001', 'Lab Mug', 'home', 1299, 10, now())
RETURNING id, sku, created_at;
ROLLBACK;`)}
<p><code>RETURNING</code> gives you the generated id (or any column) without a second query. It works on INSERT, UPDATE, DELETE and MERGE.</p>
<h2>UPDATE … FROM and DELETE … USING</h2>
<p>Join inside a write instead of looping row by row in application code:</p>
${S(`BEGIN;
-- mark every order from a deleted customer as cancelled
UPDATE orders o
SET status = 'cancelled'
FROM customers c
WHERE c.id = o.customer_id
  AND c.deleted_at IS NOT NULL
  AND o.status = 'pending';
ROLLBACK;`)}
<p>New in Postgres 18: <code>RETURNING</code> can show both the <code>old</code> and <code>new</code> row versions.</p>
${S(`BEGIN;
UPDATE products SET price_cents = round(price_cents * 1.10)
WHERE category = 'toys' AND stock = 0
RETURNING id, old.price_cents AS before, new.price_cents AS after;
ROLLBACK;`)}
<h2>Upsert: INSERT … ON CONFLICT</h2>
<p><code>ON CONFLICT (key) DO UPDATE</code> inserts, or updates the row that already exists. It’s atomic even under concurrency, which a “SELECT then INSERT” in application code never is. <code>EXCLUDED</code> refers to the row you tried to insert. The conflict target must match a unique index or constraint.</p>
${S(`BEGIN;
CREATE TEMP TABLE daily_signups (day date PRIMARY KEY, signups int NOT NULL);
INSERT INTO daily_signups VALUES ('2026-06-30', 5);
INSERT INTO daily_signups VALUES ('2026-06-30', 3), ('2026-07-01', 2)
ON CONFLICT (day) DO UPDATE SET signups = daily_signups.signups + EXCLUDED.signups;
SELECT * FROM daily_signups ORDER BY day;
ROLLBACK;`)}
<p><code>DO NOTHING</code> skips conflicting rows. Rows it skips are <em>not</em> returned by RETURNING — keep that in mind for the idempotency exercise in Module 6.</p>
<h2>MERGE</h2>
<p><code>MERGE</code> (Postgres 15+, with RETURNING since 17) handles “sync this source into that target” in one statement, with <code>WHEN MATCHED</code> and <code>WHEN NOT MATCHED</code> branches that can update, insert, delete or do nothing. For a simple upsert, ON CONFLICT is shorter and handles concurrent inserts more gracefully.</p>
${S(`BEGIN;
CREATE TEMP TABLE price_feed (sku text, price_cents int);
INSERT INTO price_feed SELECT sku, price_cents + 100 FROM products WHERE id <= 3;
INSERT INTO price_feed VALUES ('NEW-999999', 4200);
MERGE INTO products p
USING price_feed f ON f.sku = p.sku
WHEN MATCHED THEN UPDATE SET price_cents = f.price_cents
WHEN NOT MATCHED THEN DO NOTHING
RETURNING merge_action(), p.id, p.sku, p.price_cents;
ROLLBACK;`)}
${JOB(`<p>Large backfills (“update 50 million rows”) are done in batches of a few thousand rows per transaction. That keeps each transaction short, lets VACUUM keep up, avoids long row locks, and keeps replicas from lagging. Module 8 covers the pattern.</p>`)}
${INTERVIEW(`<p>“How do you insert a row only if it doesn’t exist?” The strong answer: a UNIQUE constraint plus <code>ON CONFLICT</code>. Explain why check-then-insert races: two requests both see “not there”, both insert.</p>`)}
`,
  exercises: [
    { id: 'm2-upsert', title: 'Count product views with one statement', setup: `DROP TABLE IF EXISTS product_views;
CREATE TABLE product_views (
  product_id bigint PRIMARY KEY REFERENCES products(id),
  views      integer NOT NULL
);`,
      check: { type: 'probe', verify: async (t) => {
        t.need(await t.num(`SELECT count(*) FROM pg_class WHERE relname = 'product_views' AND relkind = 'r'`) === 1, 'Table <code>product_views</code> doesn’t exist yet. Press <b>Run setup</b> first.');
        t.need(!/\b(begin|commit|rollback)\b/i.test(t.user), 'Write just the statement, with no BEGIN, COMMIT or ROLLBACK. The checker runs it inside its own transaction.');
        return t.inTx(async () => {
          await t.q('TRUNCATE product_views');
          for (let i = 1; i <= 3; i++) { const r = await t.attempt(t.user); if (!r.ok) t.fail(`Run #${i} of your statement failed: ${r.error}`); }
          const rows = await t.rows('SELECT product_id, views FROM product_views ORDER BY 1');
          t.need(rows.length === 1 && String(rows[0][0]) === '7' && String(rows[0][1]) === '3', `After running your statement 3 times on an empty table, expected exactly one row (7, 3). Got: ${rows.map((r) => '(' + r.join(', ') + ')').join(' ') || 'no rows'}.`);
          return 'Ran it 3 times inside a rolled-back transaction: one row, views = 3.';
        });
      } },
      prompt: '<p>After <b>Run setup</b>, write <em>one</em> statement that records a view of product 7. If there’s no row yet, insert <code>(7, 1)</code>. Otherwise add 1 to <code>views</code>. The checker runs your statement three times against an empty table and expects exactly one row: <code>(7, 3)</code>.</p>',
      hint: '<p><code>INSERT … VALUES (7, 1) ON CONFLICT (product_id) DO UPDATE SET views = product_views.views + 1</code></p>',
      solution: `INSERT INTO product_views (product_id, views) VALUES (7, 1)
ON CONFLICT (product_id) DO UPDATE SET views = product_views.views + 1;`,
      wrong: [`INSERT INTO product_views VALUES (7, 1);`] },
    { id: 'm2-restock', title: 'Restock the best sellers', check: { type: 'probe', verify: async (t) => {
        t.need(!/\b(begin|commit|rollback)\b/i.test(t.user), 'Write just the UPDATE, with no transaction control. The checker wraps it in a transaction and rolls back.');
        return t.inTx(async () => {
          await t.q(`CREATE TEMP TABLE _before ON COMMIT DROP AS SELECT id, stock FROM products`);
          await t.q(`CREATE TEMP TABLE _best ON COMMIT DROP AS SELECT oi.product_id FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.created_at >= '2026-06-01' AND o.created_at < '2026-07-01' GROUP BY oi.product_id HAVING sum(oi.quantity) >= 60`);
          const r = await t.attempt(t.user); if (!r.ok) t.fail('Your statement failed: ' + r.error);
          const bad = await t.rows(`SELECT p.id, p.stock - b.stock AS delta, (x.product_id IS NOT NULL) AS best FROM products p JOIN _before b ON b.id = p.id LEFT JOIN _best x ON x.product_id = p.id
            WHERE (x.product_id IS NOT NULL AND p.stock - b.stock <> 50) OR (x.product_id IS NULL AND p.stock <> b.stock) LIMIT 5`);
          const n = await t.num('SELECT count(*) FROM _best');
          t.need(bad.length === 0, `Some products changed by the wrong amount. Examples as (id, change, best_seller?): ${bad.map((r) => '(' + r.join(', ') + ')').join(' ')}`);
          return `All ${n} best sellers got +50, and nothing else changed (all rolled back).`;
        });
      } },
      prompt: '<p>Using <code>UPDATE … FROM</code>, add 50 to <code>stock</code> for every product whose total <code>quantity</code> sold in June 2026 (orders with <code>created_at</code> in June, any status) is <strong>60 or more</strong>. Leave every other product unchanged.</p>',
      hint: '<p>Put the aggregation in a subquery in the FROM list — <code>GROUP BY oi.product_id HAVING sum(oi.quantity) &gt;= 60</code> — then join it with <code>WHERE p.id = best.product_id</code>.</p>',
      solution: `UPDATE products p
SET stock = p.stock + 50
FROM (
  SELECT oi.product_id
  FROM order_items oi JOIN orders o ON o.id = oi.order_id
  WHERE o.created_at >= '2026-06-01' AND o.created_at < '2026-07-01'
  GROUP BY oi.product_id
  HAVING sum(oi.quantity) >= 60
) best
WHERE p.id = best.product_id;` },
  ],
},
]});

/* ═══════════════════════ MODULE 3 — How Postgres stores data ═══════════════════════ */
modules.push({ title: 'How Postgres stores data', lessons: [
{
  id: 'storage', title: 'Pages, tuples and the heap', minutes: 12,
  lede: 'You can’t reason about performance without a physical model. Postgres’s is simple: tables are unordered heaps of 8 KB pages, and every index points into them.',
  body: `
<p>A table is stored as a <strong>heap</strong>: a file of 8 KB pages holding row versions (<em>tuples</em>) in no particular order. Each tuple has a ~23-byte header (visibility info, among other things) and its address is a <code>ctid</code> = (page, slot).</p>
${S(`SELECT ctid, id, status, created_at FROM orders ORDER BY id LIMIT 5;`)}
<p>There is <strong>no clustered index</strong>. In MySQL/InnoDB the table <em>is</em> the primary-key B-tree. In Postgres every index, the primary key included, is a separate structure whose entries point at ctids. <code>CLUSTER</code> reorders a table once by an index, but the order isn’t maintained afterwards.</p>
<h2>How big is everything?</h2>
${S(`SELECT relname,
       pg_size_pretty(pg_relation_size(oid))       AS heap,
       pg_size_pretty(pg_indexes_size(oid))        AS indexes,
       pg_size_pretty(pg_total_relation_size(oid)) AS total,
       relpages, reltuples::bigint                 AS est_rows
FROM pg_class
WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'
ORDER BY pg_total_relation_size(oid) DESC;`)}
<p><code>relpages</code> and <code>reltuples</code> are the planner’s picture of each table, updated by VACUUM and ANALYZE. Remember them for Module 4.</p>
<h2>Look inside a page</h2>
<p>The <code>pageinspect</code> extension (installed here) decodes raw pages. Each line pointer (<code>lp</code>) is a slot; <code>t_xmin</code> is the transaction that created the tuple; <code>t_xmax</code> is the one that deleted or locked it (0 = nobody).</p>
${S(`SELECT lp, lp_len, t_xmin, t_xmax, t_ctid
FROM heap_page_items(get_raw_page('employees', 0))
LIMIT 5;`)}
<h2>TOAST: where big values go</h2>
<p>A value larger than about 2 KB is compressed and/or moved out of line into a TOAST table. That keeps the main heap compact, but <code>SELECT *</code> on wide rows fetches and decompresses everything. Select the columns you need, especially in hot paths.</p>
<h2>Why count(*) isn’t free</h2>
<p>Postgres doesn’t store a row count. Visibility is per tuple (the next lesson), so counting means visiting the rows, or an index plus the visibility map. For a UI, an estimate is often enough:</p>
${S(`SELECT reltuples::bigint AS estimate FROM pg_class WHERE relname = 'order_items';
SELECT count(*) AS exact FROM order_items;`)}
${INTERVIEW(`<p>“Why is <code>count(*)</code> slow in Postgres when MySQL/MyISAM was instant?” — MVCC: different transactions can legitimately see different counts, so there’s no single number to store. “What’s a ctid? Can I use it as an id?” — it’s a physical address that changes on every UPDATE and on VACUUM FULL, so no.</p>`)}
`,
  exercises: [
    { id: 'm3-sizes', title: 'Rank the tables by total size', check: { type: 'result' },
      prompt: '<p>Return every ordinary table in the <code>public</code> schema with its total on-disk size in bytes (heap + indexes + TOAST). Columns: table name and the byte count.</p>',
      hint: '<p><code>pg_total_relation_size(oid)</code> over <code>pg_class</code> where <code>relkind = \'r\'</code> and <code>relnamespace = \'public\'::regnamespace</code>.</p>',
      solution: `SELECT relname, pg_total_relation_size(oid)
FROM pg_class
WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace
ORDER BY 2 DESC;` },
    { id: 'm3-perpage', title: 'Rows per page', check: { type: 'result' },
      prompt: '<p>Using only <code>pg_class</code>, compute the average number of rows per 8 KB page for <code>orders</code>, <code>order_items</code> and <code>events</code>. Columns: <code>relname</code>, and <code>rows_per_page</code> rounded to 1 decimal.</p>',
      hint: '<p><code>reltuples / relpages</code>. <code>reltuples</code> is a <code>real</code>, so cast to numeric before <code>round(…, 1)</code>.</p>',
      solution: `SELECT relname, round((reltuples / relpages)::numeric, 1) AS rows_per_page
FROM pg_class
WHERE relname IN ('orders', 'order_items', 'events');`,
      after: 'Narrow rows pack more per page, and more rows per page means fewer pages to read in a scan. That’s why wide <code>SELECT *</code> tables and TOAST-heavy rows scan slower.' },
  ],
},
{
  id: 'mvcc', title: 'MVCC: every UPDATE writes a new row', minutes: 18,
  lede: 'Readers never block writers and writers never block readers — because Postgres keeps multiple versions of each row. That design explains VACUUM, bloat, HOT updates and a surprising number of incidents.',
  body: `
<p>Each tuple records <code>xmin</code> (the transaction that created it) and <code>xmax</code> (the one that deleted it, if any). Every statement runs against a <em>snapshot</em> — the set of transactions it treats as committed — and a tuple is visible if its xmin is committed in that snapshot and its xmax isn’t. An <strong>UPDATE doesn’t change a row in place</strong>: it sets xmax on the old version and inserts a new version. A DELETE only sets xmax.</p>
${S(`DROP TABLE IF EXISTS mvcc_demo;
CREATE TABLE mvcc_demo (id int PRIMARY KEY, val text);
INSERT INTO mvcc_demo VALUES (1, 'original');
SELECT ctid, xmin, xmax, * FROM mvcc_demo;
UPDATE mvcc_demo SET val = 'changed' WHERE id = 1;
SELECT ctid, xmin, xmax, * FROM mvcc_demo;`)}
<p>The ctid moved from <code>(0,1)</code> to <code>(0,2)</code>, and xmin changed to your UPDATE’s transaction. The old version is still on the page:</p>
${S(`SELECT lp, t_xmin, t_xmax, t_ctid, lp_flags
FROM heap_page_items(get_raw_page('mvcc_demo', 0));`)}
<p>Slot 1 has <code>t_xmax</code> set and its <code>t_ctid</code> points to slot 2 — an update chain. No snapshot will ever see slot 1 again, so it’s a <strong>dead tuple</strong>.</p>
${SIM('mvcc-readers')}
<h2>VACUUM cleans up</h2>
<p><code>VACUUM</code> removes dead tuples no snapshot can see, makes their space reusable, and updates the <em>visibility map</em> (which pages are all-visible — used by index-only scans) and the free-space map. It does <strong>not</strong> shrink the file. <code>VACUUM FULL</code> rewrites the table compactly, but holds an ACCESS EXCLUSIVE lock the whole time — nothing can even read the table. In production, reach for <code>pg_repack</code> instead.</p>
${S(`VACUUM (VERBOSE) mvcc_demo;
SELECT lp, t_xmin, t_xmax, t_ctid, lp_flags FROM heap_page_items(get_raw_page('mvcc_demo', 0));`)}
${LAB(`<p>On a real server <strong>autovacuum</strong> does this in the background. By default it vacuums a table once about 20% of its rows are dead (and analyzes it after about 10% change). There is no autovacuum here, so dead tuples pile up until <em>you</em> run VACUUM. That makes the effects easy to see.</p>`)}
<h2>Bloat, and the transaction that ate the database</h2>
<p>VACUUM can only remove versions that <em>no</em> running transaction might still need. One long-running transaction — a stuck report, a connection left <code>idle in transaction</code>, an abandoned replication slot — holds back that horizon for the whole cluster. Dead tuples accumulate everywhere, tables and indexes bloat, queries slow down. It’s one of the most common Postgres incidents. The fix is to find and end that transaction (Module 8 shows how).</p>
<h2>HOT updates</h2>
<p>If an UPDATE changes <em>no indexed column</em> and the new version fits on the <em>same page</em>, Postgres does a <strong>Heap-Only Tuple</strong> update: indexes aren’t touched at all, because the old line pointer redirects to the new version. That makes HOT updates much cheaper. You encourage them by not indexing frequently updated columns, and by leaving free space in pages with <code>fillfactor</code> (e.g. 80–90 for update-heavy tables). <code>pg_stat_user_tables.n_tup_hot_upd</code> shows how often you get them.</p>
<h2>Transaction ID wraparound</h2>
<p>Transaction ids are 32 bits, and visibility uses modular comparison, so very old xids must be <em>frozen</em> (marked “visible to everyone”) before about 2 billion newer transactions make them look like the future. Autovacuum freezes as it goes. If it can’t keep up, Postgres escalates to aggressive anti-wraparound vacuums and, in the worst case, stops accepting writes to protect your data. Monitor <code>age(datfrozenxid)</code>.</p>
${S(`SELECT datname, age(datfrozenxid) AS xid_age FROM pg_database ORDER BY 2 DESC;`)}
${QUIZ('q-bloat', 'Autovacuum is off. You UPDATE every row of a 1 GB table once. Roughly how big is the table afterwards?', ['Still about 1 GB — updates happen in place', 'About 2 GB — every row now has a dead version too', 'About 0.5 GB — Postgres compresses on update'], 1, 'Each UPDATE writes a new tuple version and leaves the old one dead, so the heap roughly doubles. VACUUM makes that space reusable but won’t shrink the file. VACUUM FULL (or pg_repack) does.')}
${INTERVIEW(`<p>Top-five Postgres questions: “What happens when you UPDATE a row?”, “Why do we need VACUUM?”, “How can one long-running transaction hurt the whole database?”, “What is a HOT update?”, “What is transaction ID wraparound?”. You can now answer all five from first principles.</p>`)}
`,
  exercises: [
    { id: 'm3-bloat', title: 'Bloat lab: double it, then shrink it', setup: `DROP TABLE IF EXISTS orders_copy;
CREATE TABLE orders_copy AS SELECT * FROM orders;
DROP TABLE IF EXISTS lab_bloat_meta;
CREATE TABLE lab_bloat_meta AS
SELECT pg_relation_size('orders_copy') AS size0,
       (SELECT relfilenode FROM pg_class WHERE relname = 'orders_copy') AS node0,
       (SELECT count(*) FROM orders_copy) AS rows0;
SELECT pg_size_pretty(size0) AS orders_copy_size FROM lab_bloat_meta;`,
      check: { type: 'state', verify: async (t) => {
        t.need(await t.num(`SELECT count(*) FROM pg_class WHERE relname IN ('orders_copy', 'lab_bloat_meta')`) === 2, 'Press <b>Run setup</b> first. It creates <code>orders_copy</code> and records its starting size.');
        const [size0, node0, rows0] = (await t.rows('SELECT size0, node0, rows0 FROM lab_bloat_meta'))[0];
        const size = await t.num(`SELECT pg_relation_size('orders_copy')`);
        const node = await t.val(`SELECT relfilenode FROM pg_class WHERE relname = 'orders_copy'`);
        const rows = await t.num('SELECT count(*) FROM orders_copy');
        t.need(Number(rows) === Number(rows0), `orders_copy should still have ${rows0} rows, but has ${rows}.`);
        t.need(String(node) !== String(node0), 'The table file was never rewritten. After your UPDATE, reclaim the space with a command that rewrites the table.');
        t.need(size <= Number(size0) * 1.1, `orders_copy is ${(size / 1e6).toFixed(1)} MB, but started at ${(size0 / 1e6).toFixed(1)} MB. Plain VACUUM makes space reusable but doesn’t shrink the file.`);
        return 'The table was rewritten back to its original size. You just watched bloat happen and undid it.';
      } },
      prompt: '<p>After <b>Run setup</b>:</p><ol><li>UPDATE every row of <code>orders_copy</code> once (e.g. <code>SET total_cents = total_cents</code>).</li><li>Check <code>pg_size_pretty(pg_relation_size(\'orders_copy\'))</code> — it should have roughly doubled.</li><li>Try plain <code>VACUUM</code> and check again. Then shrink the file back.</li></ol>',
      hint: '<p>Plain VACUUM leaves the file size alone. <code>VACUUM FULL orders_copy</code> rewrites it. (It takes an ACCESS EXCLUSIVE lock — fine here, dangerous on a busy production table.)</p>',
      solution: `UPDATE orders_copy SET total_cents = total_cents;
SELECT pg_size_pretty(pg_relation_size('orders_copy')) AS after_update;
VACUUM orders_copy;
SELECT pg_size_pretty(pg_relation_size('orders_copy')) AS after_vacuum;
VACUUM FULL orders_copy;
SELECT pg_size_pretty(pg_relation_size('orders_copy')) AS after_vacuum_full;`,
      teardown: `DROP TABLE IF EXISTS orders_copy; DROP TABLE IF EXISTS lab_bloat_meta;` },
    { id: 'm3-hot', title: 'Make the counter updates HOT', setup: `DROP TABLE IF EXISTS counters;
CREATE TABLE counters (id int PRIMARY KEY, hits int NOT NULL DEFAULT 0, label text NOT NULL);
INSERT INTO counters SELECT g, 0, 'counter #' || g FROM generate_series(1, 20000) g;
CREATE INDEX counters_hits_idx ON counters (hits);   -- a teammate added this "for the dashboard"
VACUUM ANALYZE counters;`,
      check: { type: 'state', verify: async (t) => {
        t.need(await t.num(`SELECT count(*) FROM pg_class WHERE relname = 'counters'`) === 1, 'Press <b>Run setup</b> first.');
        await t.q('SELECT pg_stat_force_next_flush()');
        const [upd, hot] = ((await t.rows(`SELECT n_tup_upd, n_tup_hot_upd FROM pg_stat_user_tables WHERE relname = 'counters'`))[0] || [0, 0]).map(Number);
        t.need(upd >= 2000, `Only ${upd} updates recorded so far. Run the workload <code>UPDATE counters SET hits = hits + 1 WHERE id % 10 = 0;</code> (after fixing the table), then check again.`);
        const ratio = hot / upd;
        t.need(ratio >= 0.9, `${Math.round(ratio * 100)}% of ${upd} updates were HOT, and the goal is at least 90%. HOT needs two things: no index on a column you update, and free space on the page. If you ran the workload before fixing the table, press <b>Run setup</b> again to reset the counters.`);
        return `${Math.round(ratio * 100)}% of updates were HOT — no index maintenance for those rows.`;
      } },
      prompt: '<p>After <b>Run setup</b>, the table <code>counters</code> gets this workload, over and over:</p><pre style="margin:0 0 10px">UPDATE counters SET hits = hits + 1 WHERE id % 10 = 0;</pre><p>Right now almost none of those updates are HOT. Change the <em>table</em> (not the workload) so at least 90% become HOT, then run the workload once and check. Watch <code>n_tup_upd</code> and <code>n_tup_hot_upd</code> in <code>pg_stat_user_tables</code>.</p>',
      hint: '<p>Two blockers. (1) <code>hits</code> is indexed, so changing it always touches the index. (2) Pages are 100% full, so the new version can’t stay on the same page. Drop the index, then <code>ALTER TABLE counters SET (fillfactor = 80)</code>. The new fillfactor only applies to pages written from now on, so rewrite the table with <code>VACUUM FULL counters</code>.</p>',
      solution: `DROP INDEX counters_hits_idx;
ALTER TABLE counters SET (fillfactor = 80);
VACUUM FULL counters;
UPDATE counters SET hits = hits + 1 WHERE id % 10 = 0;`,
      teardown: `DROP TABLE IF EXISTS counters;` },
  ],
},
]});

/* ═══════════════════════ MODULE 4 — Reading query plans ═══════════════════════ */
modules.push({ title: 'Reading query plans', lessons: [
{
  id: 'explain', title: 'EXPLAIN, EXPLAIN ANALYZE and ANALYZE', minutes: 18,
  lede: 'Three commands with confusingly similar names. One shows the plan, one runs the query and measures it, and one has nothing to do with either — it refreshes the statistics the planner relies on.',
  body: `
${TABLE(['Command', 'What it does', 'Runs your query?'], [
  ['<code>EXPLAIN q</code>', 'Shows the plan the planner <em>would</em> use, with its estimates (cost, rows, width).', 'No'],
  ['<code>EXPLAIN ANALYZE q</code>', 'Runs the query, then shows the plan with estimates <em>and</em> actual rows, time and loops per node. In Postgres 18 it also shows buffer counts by default.', '<strong>Yes</strong> — including any writes'],
  ['<code>ANALYZE t</code>', 'Samples the table and updates the planner’s statistics (<code>pg_statistic</code>). Only the name is shared with EXPLAIN ANALYZE.', 'n/a'],
])}
<h2>Your first plan</h2>
${S(`EXPLAIN SELECT * FROM orders WHERE customer_id = 42;`)}
<p>You’ll see something like <code>Seq Scan on orders (cost=0.00..8776.00 rows=200 width=49)</code>:</p>
<ul>
  <li><strong>cost=startup..total</strong> — in arbitrary units, roughly “one sequential page read = 1”. Startup is the cost before the first row comes out; total is the cost to produce all rows. The planner picks the plan with the lowest total.</li>
  <li><strong>rows</strong> — the estimated number of rows this node outputs. <strong>width</strong> — the estimated average row size in bytes.</li>
</ul>
<p>The cost isn’t magic. For a seq scan it’s <code>pages × seq_page_cost + rows × cpu_tuple_cost + rows × cpu_operator_cost</code> (for the filter). Check it against the table:</p>
${S(`SELECT relpages, reltuples,
       relpages * current_setting('seq_page_cost')::float8
     + reltuples * current_setting('cpu_tuple_cost')::float8
     + reltuples * current_setting('cpu_operator_cost')::float8 AS seq_scan_cost
FROM pg_class WHERE relname = 'orders';`)}
<h2>Now measure it</h2>
${S(`EXPLAIN ANALYZE SELECT * FROM orders WHERE customer_id = 42;`)}
<ul>
  <li><strong>actual time=first..last</strong> — milliseconds <em>per loop</em> to the first and to the last row.</li>
  <li><strong>rows</strong> (actual, per loop — Postgres 18 prints decimals) and <strong>loops</strong>. Multiply by loops to get totals: the inner side of a nested loop can run 50,000 times.</li>
  <li><strong>Rows Removed by Filter</strong> — work that produced nothing. Big numbers here mean you read too much.</li>
  <li><strong>Buffers: shared hit / read / dirtied</strong> — 8 KB pages found in Postgres’s cache vs fetched from the OS or disk. It’s the best proxy for I/O.</li>
</ul>
<p>Read a plan <strong>inside-out</strong>: the most-indented nodes run first and feed rows up to their parents. In this console’s plan viewer, the amber bar shows time spent <em>in that node itself</em>, a red badge flags an estimate that’s off by 10× or more, and an amber badge means the node spilled to disk. Switch to <b>Raw text</b> to see what psql prints.</p>
${QUIZ('q-analyze', 'Which command changes what the planner knows about your data?', ['EXPLAIN', 'EXPLAIN ANALYZE', 'ANALYZE', 'VACUUM FULL'], 2, 'ANALYZE samples the table and rewrites its statistics. EXPLAIN ANALYZE only runs and measures one query. (VACUUM FULL rewrites the table; <code>VACUUM ANALYZE</code> does both jobs.)')}
${QUIZ('q-loops', 'An inner Index Scan shows <code>actual time=0.010..0.012 rows=3 loops=50000</code>. About how much total time did it take?', ['0.012 ms', '12 ms', '600 ms', 'Can’t tell'], 2, 'Times are per loop: 0.012 ms × 50,000 loops ≈ 600 ms. Nested loops that look cheap per iteration are a classic hidden cost.')}
<h2>EXPLAIN ANALYZE a write without doing it</h2>
${WARN(`<p><code>EXPLAIN ANALYZE DELETE …</code> really deletes. To measure a write safely, wrap it: <code>BEGIN; EXPLAIN ANALYZE …; ROLLBACK;</code>. The same care applies to <code>EXPLAIN ANALYZE</code> on a heavy SELECT in production: it runs the full query.</p>`)}
<h2>Options you’ll actually use</h2>
<ul>
  <li><code>EXPLAIN (ANALYZE, BUFFERS, VERBOSE, SETTINGS)</code> — the full picture; VERBOSE shows output columns, SETTINGS shows non-default planner settings.</li>
  <li><code>EXPLAIN (COSTS OFF)</code> — just the shape, handy when comparing plans.</li>
  <li><code>EXPLAIN (ANALYZE, FORMAT JSON)</code> — paste into <a href="https://explain.dalibo.com" target="_blank" rel="noopener">explain.dalibo.com</a> or <a href="https://explain.depesz.com" target="_blank" rel="noopener">explain.depesz.com</a> for a visual breakdown.</li>
</ul>
<h2>The debugging loop</h2>
<ol>
  <li>Find the node with the most exclusive time.</li>
  <li>Compare <em>estimated</em> vs <em>actual</em> rows at and below it. A bad estimate is the usual root cause of a bad plan.</li>
  <li>Check buffers: lots of <code>read</code> means I/O; lots of rows removed by filter means a missing or unusable index.</li>
  <li>Fix one thing — an index, statistics, a query rewrite, or a setting like <code>work_mem</code>.</li>
  <li>Re-run and compare the numbers.</li>
</ol>
${INTERVIEW(`<p>“Walk me through how you’d investigate a slow query” is asked in nearly every backend loop. Recite the loop above, name the node types you’d expect, and say “estimated vs actual rows” out loud. Mentioning that EXPLAIN ANALYZE executes the statement (so wrap writes in a rolled-back transaction) shows production maturity.</p>`)}
`,
  exercises: [
    { id: 'm4-safe-explain', title: 'Measure a DELETE without deleting', check: { type: 'probe', verify: async (t) => {
        const COUNT = `SELECT count(*) FROM events WHERE event_type = 'page_view' AND occurred_at < '2026-01-15'`;
        t.need(/\b(begin|start\s+transaction)\b/i.test(t.user), 'Your script needs to open a transaction itself (BEGIN), so it’s safe when you run it on its own.');
        const c0 = await t.num(COUNT);
        await t.q('BEGIN');
        let res;
        try { res = await t.q(t.user); } catch (e) { await t.q('ROLLBACK').catch(() => {}); throw e; }
        const still = await t.inTxNow();
        if (still) { await t.q('ROLLBACK'); t.fail('Your script left the transaction open. On its own it would have deleted the rows when the session committed. End it with ROLLBACK. (The checker rolled back for you.)'); }
        const c1 = await t.num(COUNT);
        t.need(c1 === c0, `Rows were deleted: ${c0} before, ${c1} after. Did your script end with COMMIT?`);
        const plan = res.filter((r) => r.fields.length === 1 && r.fields[0].name === 'QUERY PLAN').map((r) => r.rows.map((x) => x[0]).join('\n')).join('\n');
        t.need(/Delete on events/.test(plan) && /actual time|actual rows/.test(plan), 'Your script must include <code>EXPLAIN ANALYZE DELETE …</code>, so the output shows actual times for the delete.');
        return `Measured the real delete plan, and all ${c0} rows are still there.`;
      } },
      prompt: '<p>Write a script that shows the <em>actual</em> execution plan (with timings) of</p><pre style="margin:0 0 10px">DELETE FROM events WHERE event_type = \'page_view\' AND occurred_at &lt; \'2026-01-15\'</pre><p>without deleting anything.</p>',
      hint: '<p>Three statements: <code>BEGIN;</code>, <code>EXPLAIN ANALYZE DELETE …;</code>, <code>ROLLBACK;</code></p>',
      solution: `BEGIN;
EXPLAIN ANALYZE DELETE FROM events WHERE event_type = 'page_view' AND occurred_at < '2026-01-15';
ROLLBACK;` },
  ],
},
{
  id: 'scans', title: 'Scan types: why Postgres ignores your index', minutes: 18,
  lede: 'An index is an option, not an order. The planner compares the costs of reading the whole table against jumping around via an index, and it’s usually right — when its statistics are right.',
  body: `
${TABLE(['Node', 'How it works', 'Wins when'], [
  ['<b>Seq Scan</b>', 'Reads every page in order.', 'You need a big fraction of the table, or the table is small.'],
  ['<b>Index Scan</b>', 'Walks the B-tree, then fetches each matching tuple from the heap (random I/O).', 'Few rows match, or you need index order (ORDER BY … LIMIT).'],
  ['<b>Bitmap Index + Bitmap Heap Scan</b>', 'Collects matching TIDs into a bitmap, sorts them by page, and visits each page once. Can combine indexes (BitmapAnd/BitmapOr).', 'A “medium” number of rows, or several indexes combined.'],
  ['<b>Index Only Scan</b>', 'Answers from the index alone when every needed column is in it and the visibility map says the page is all-visible.', 'Covering indexes on mostly-static data (Module 5).'],
])}
<h2>Watch a plan change</h2>
<p>There’s no index on <code>orders.customer_id</code>. Postgres automatically indexes primary keys and unique constraints, <em>never</em> foreign keys:</p>
${S(`EXPLAIN ANALYZE SELECT * FROM orders WHERE customer_id = 4242;`)}
${S(`CREATE INDEX IF NOT EXISTS orders_customer_id_idx ON orders (customer_id);
EXPLAIN ANALYZE SELECT * FROM orders WHERE customer_id = 4242;`)}
<p>Tens of milliseconds became a fraction of one. Now try the heavy customers and a wide range — the same index, but different plans:</p>
${S(`EXPLAIN ANALYZE SELECT * FROM orders WHERE customer_id = 1;      -- a heavy buyer
EXPLAIN ANALYZE SELECT * FROM orders WHERE customer_id < 5000;   -- about a third of all orders`)}
<p>For customer 1 you’ll likely get a Bitmap Heap Scan: many rows, spread over many pages. For <code>&lt; 5000</code> it’s a Seq Scan, because reading everything sequentially beats hundreds of thousands of random fetches. <strong>Selectivity decides.</strong></p>
<h2>Low-cardinality columns</h2>
<p>77% of orders are <code>delivered</code>. An index on <code>status</code> is useless for that value, but excellent for <code>pending</code> (about 1%). That’s the idea behind <em>partial indexes</em> (next module).</p>
<h2>Experiments, not production code</h2>
${S(`SET enable_seqscan = off;   -- make seq scans look very expensive
EXPLAIN SELECT * FROM orders WHERE customer_id < 5000;
RESET enable_seqscan;`)}
<p>The forced plan’s cost is higher than the seq scan’s — that’s <em>why</em> it wasn’t chosen. The cost model assumes <code>random_page_cost = 4</code> (spinning disks). On SSDs most teams set about 1.1, which makes index scans win more often:</p>
${S(`SET random_page_cost = 1.1;
EXPLAIN SELECT * FROM orders WHERE customer_id < 2000;
RESET random_page_cost;`)}
<h2>Why isn’t my index used? The checklist</h2>
<ol>
  <li>The predicate isn’t selective enough (the planner is right).</li>
  <li>A function or cast wraps the column: <code>lower(email) = …</code>, <code>created_at::date = …</code>. The index is on the column, not the expression.</li>
  <li>The types don’t match, e.g. comparing a <code>bigint</code> column to a <code>numeric</code> parameter.</li>
  <li>A leading wildcard: <code>LIKE '%foo'</code> (a B-tree can’t help; trigram indexes can).</li>
  <li>The composite index doesn’t lead with your filtered column (Postgres 18’s skip scan sometimes rescues this).</li>
  <li>Stale or misleading statistics — the lesson after next.</li>
  <li>The table is tiny, so a seq scan is genuinely cheaper.</li>
</ol>
${QUIZ('q-ios', 'Which node can answer a query without touching the table’s heap at all (when the visibility map allows)?', ['Bitmap Heap Scan', 'Index Scan', 'Index Only Scan', 'Seq Scan'], 2, 'Index Only Scan reads only the index, checking the visibility map to skip heap visits. If pages aren’t marked all-visible (VACUUM sets that), you’ll see “Heap Fetches” climb.')}
${INTERVIEW(`<p>“Why isn’t Postgres using my index?” — go through the checklist above in order. Bonus points for “I’d compare EXPLAIN with <code>enable_seqscan = off</code> to see the cost the planner rejected” and “foreign keys aren’t indexed automatically.”</p>`)}
`,
  exercises: [
    { id: 'm4-fk-index', title: 'Index the foreign key', setup: DROP_EXTRA('orders'),
      check: { type: 'state', verify: async (t) => {
        const nodes = t.nodes(await t.plan('SELECT * FROM orders WHERE customer_id = 4242'));
        t.need(!seqOn(nodes, 'orders'), 'The plan for <code>SELECT * FROM orders WHERE customer_id = 4242</code> is still a Seq Scan on orders.');
        return 'The lookup now uses an index.';
      } },
      prompt: '<p>Make <code>SELECT * FROM orders WHERE customer_id = 4242</code> stop doing a sequential scan. (<b>Run setup</b> is optional: it drops any extra indexes you’ve created on <code>orders</code>, so you start clean.)</p>',
      hint: '<p>A plain B-tree index on <code>orders (customer_id)</code>.</p>',
      solution: `CREATE INDEX orders_customer_id_idx ON orders (customer_id);`,
      after: 'Every foreign key column that you join on, or delete parents by, deserves an index. Without one, deleting a single customer has to scan all of <code>orders</code> to check for references.' },
    { id: 'm4-sargable', title: 'Make the date filter index-friendly', check: { type: 'result', extra: async (t) => {
        const nodes = t.nodes(await t.plan(t.lastStmt()));
        t.need(!seqOn(nodes, 'orders'), 'The count is right, but your query still scans all of <code>orders</code>. Rewrite the predicate as a range on the bare column, and make sure an index on <code>created_at</code> exists.');
      } },
      prompt: '<p>A dashboard runs <code>SELECT count(*) FROM orders WHERE created_at::date = \'2026-06-15\'</code>. Return the same count with a query that can use an index on <code>created_at</code> — and create that index. The checker verifies the result <em>and</em> that the plan doesn’t seq-scan orders.</p>',
      hint: '<p>The cast hides the column from the index. Use a half-open range instead: <code>created_at &gt;= \'2026-06-15\' AND created_at &lt; \'2026-06-16\'</code>. You can put <code>CREATE INDEX IF NOT EXISTS …;</code> before the SELECT in the same editor.</p>',
      solution: `CREATE INDEX IF NOT EXISTS orders_created_at_idx ON orders (created_at);
SELECT count(*) FROM orders WHERE created_at >= '2026-06-15' AND created_at < '2026-06-16';`,
      wrong: [`CREATE INDEX IF NOT EXISTS orders_created_at_idx ON orders (created_at);
SELECT count(*) FROM orders WHERE created_at::date = '2026-06-15';`],
      after: 'An index-friendly predicate is called “sargable”. The rule: keep the indexed column bare on one side of the comparison, and move all the math to the constant side.' },
  ],
},
{
  id: 'joins', title: 'Join algorithms and work_mem', minutes: 16,
  lede: 'Postgres has three ways to join two inputs. Knowing which one it picked — and why — explains most “this join is slow” tickets.',
  body: `
${TABLE(['Algorithm', 'How it works', 'Good when', 'Watch for'], [
  ['<b>Nested Loop</b>', 'For each outer row, probe the inner side (ideally with an index).', 'The outer side is small and the inner side is indexed on the join key.', 'A misestimated outer side (“rows=1”, actually 100k) → 100k probes.'],
  ['<b>Hash Join</b>', 'Build a hash table from the smaller input, then stream the other through it.', 'Big, unsorted inputs joined on equality.', 'The hash exceeds <code>work_mem × hash_mem_multiplier</code> → “Batches: N” spills to disk.'],
  ['<b>Merge Join</b>', 'Walk two inputs sorted on the join key in lockstep.', 'Both sides are already sorted (by an index) or needed sorted anyway.', 'Sorting huge inputs just to merge them.'],
])}
<h2>See each one</h2>
${S(`-- A handful of customers × indexed orders → Nested Loop (if you created orders_customer_id_idx)
EXPLAIN ANALYZE
SELECT c.full_name, o.id, o.total_cents
FROM customers c JOIN orders o ON o.customer_id = c.id
WHERE c.city = 'Singapore' AND c.tier = 'enterprise';`)}
${S(`-- 1.2M order_items × 5k products → Hash Join (hash the small side)
EXPLAIN ANALYZE
SELECT p.category, sum(oi.quantity) AS units
FROM order_items oi JOIN products p ON p.id = oi.product_id
GROUP BY p.category;`)}
${S(`-- Both sides can be read in id order → often a Merge Join
EXPLAIN ANALYZE
SELECT count(*) FROM orders o JOIN order_items oi ON oi.order_id = o.id
WHERE o.id < 50000;`)}
<h2>work_mem: the per-operation memory budget</h2>
<p>Each sort and hash node may use up to <code>work_mem</code> (default 4 MB; hashes get <code>× hash_mem_multiplier</code>, default 2) before spilling to temporary files. The budget is <em>per node, per query, per connection</em>. A report with three sorts across 100 connections can use 300 × work_mem, which is why nobody sets it to 1 GB globally.</p>
${S(`SET work_mem = '64kB';
EXPLAIN ANALYZE SELECT * FROM orders ORDER BY total_cents DESC LIMIT 100000;
RESET work_mem;
EXPLAIN ANALYZE SELECT * FROM orders ORDER BY total_cents DESC LIMIT 100000;`)}
<p>Look for <code>Sort Method: external merge Disk: …</code> versus <code>top-N heapsort Memory: …</code>. For hashes, the tell is <code>Batches:</code> greater than 1.</p>
<h2>Join order and estimates</h2>
<p>The planner searches join orders exhaustively up to <code>join_collapse_limit</code> (8 tables) and switches to a genetic algorithm beyond <code>geqo_threshold</code> (12). The biggest risk isn’t the search, though — it’s bad row estimates feeding it. A nested loop chosen because the planner expected 1 row but got 100,000 is the classic disaster.</p>
${QUIZ('q-nl', 'A Nested Loop’s outer side returns 200,000 rows, and the inner side is a Seq Scan on a 1M-row table. What’s the most likely fix?', ['Increase work_mem', 'Index the inner table’s join column (and check why the planner expected few outer rows)', 'Add LIMIT', 'Run VACUUM FULL'], 1, 'Each outer row triggers a full scan of the inner table: 200k × 1M. An index turns each probe into a quick B-tree lookup, and fixing the estimate lets the planner pick a hash join instead.')}
${INTERVIEW(`<p>“Explain hash, merge and nested-loop joins, and when each wins” is a standard deep-dive question. Tie each one to data sizes and indexes, and mention that <code>work_mem</code> is per operation per connection.</p>`)}
`,
  exercises: [
    { id: 'm4-workmem', title: 'Keep the sort in memory', setup: `SET work_mem = '64kB';`,
      check: { type: 'state', verify: async (t) => {
        const nodes = t.nodes(await t.plan('SELECT * FROM orders ORDER BY total_cents DESC LIMIT 100000', true));
        const s = sorts(nodes)[0];
        t.need(s, 'No Sort node in the plan. Did an index on total_cents appear? This exercise is about the sort — drop that index.');
        t.need(s['Sort Space Type'] === 'Memory', `The sort still spills: ${s['Sort Method']} using ${s['Sort Space Used']} kB on ${s['Sort Space Type']}.`);
        return `Sort Method: ${s['Sort Method']} — all in memory (${s['Sort Space Used']} kB).`;
      } },
      teardown: 'RESET work_mem;',
      prompt: '<p><b>Run setup</b> sets <code>work_mem</code> to 64 kB for your session. Make <code>SELECT * FROM orders ORDER BY total_cents DESC LIMIT 100000</code> sort entirely in memory by changing a setting for <em>this session only</em>. Don’t add an index.</p>',
      hint: '<p><code>SET work_mem = \'32MB\';</code> — then check EXPLAIN ANALYZE for “Memory” instead of “Disk”.</p>',
      solution: `SET work_mem = '32MB';`,
      after: 'In production, raise work_mem for the few sessions that need it (a reporting role, or <code>SET LOCAL work_mem</code> inside one transaction) rather than globally.' },
  ],
},
{
  id: 'stats', title: 'Statistics: what the planner believes', minutes: 16,
  lede: 'Every estimate in a plan comes from statistics that ANALYZE collected. When they’re stale or too simple, good indexes go unused and joins pick the wrong algorithm.',
  body: `
<p><code>ANALYZE</code> samples up to 300 × <code>default_statistics_target</code> (100), so 30,000 rows per table, and stores per-column statistics. You can read them in <code>pg_stats</code>:</p>
${S(`SELECT attname, null_frac, n_distinct, most_common_vals, most_common_freqs, correlation
FROM pg_stats
WHERE tablename = 'orders' AND attname IN ('status', 'coupon_code', 'customer_id', 'created_at');`)}
<ul>
  <li><strong>null_frac</strong> — the fraction of NULLs. <strong>n_distinct</strong> — the number of distinct values (negative means “this fraction of the row count”).</li>
  <li><strong>most_common_vals / freqs</strong> (MCVs) — for <code>status = 'pending'</code> the planner uses the listed frequency directly.</li>
  <li><strong>histogram_bounds</strong> — equal-population buckets for range predicates on non-MCV values.</li>
  <li><strong>correlation</strong> — how well the physical order follows the value order (from −1 to 1). <code>created_at</code> is close to 1 here, which makes index range scans cheap and BRIN possible.</li>
</ul>
<h2>Where estimates go wrong</h2>
<p><strong>1. Stale statistics.</strong> After a bulk load or a big delete, the statistics describe the old data until the next ANALYZE. Autovacuum eventually analyzes, but a batch job that loads and then immediately queries races it. This lab has no autovacuum, so you’re in charge. The habit to take away: run <code>ANALYZE</code> right after large loads.</p>
<p><strong>2. Correlated columns.</strong> The planner multiplies selectivities as if columns were independent. City and country are not:</p>
${S(`EXPLAIN ANALYZE SELECT * FROM customers WHERE country = 'FR' AND city = 'Paris';`)}
<p>It assumes P(FR) × P(Paris) — roughly 5% × 4% — and underestimates by about 20×, because every Paris row is in France. <strong>Extended statistics</strong> teach it the dependency. You’ll add them in the exercise.</p>
<p><strong>3. Heavy skew.</strong> If some values are much more common than the MCV list captures, raise the sample for that column: <code>ALTER TABLE orders ALTER COLUMN customer_id SET STATISTICS 1000; ANALYZE orders;</code></p>
<p><strong>4. Generic plans.</strong> Prepared statements (most drivers and ORMs) may switch to a generic plan that ignores the actual parameter values after five executions. That’s great for uniform data and bad for skewed data. Look into <code>plan_cache_mode</code>.</p>
${JOB(`<p>“It was fast yesterday and nothing was deployed” usually means the data changed shape and the statistics or the plan flipped. Check <code>last_autoanalyze</code> in <code>pg_stat_user_tables</code>, compare estimated vs actual rows, and ANALYZE. Postgres 18’s <code>pg_upgrade</code> finally carries statistics across major-version upgrades, so you no longer start with a blind planner after upgrading.</p>`)}
${INTERVIEW(`<p>Be ready to explain how the planner estimates <code>WHERE a = 1 AND b = 2</code> (it multiplies, assuming independence) and what CREATE STATISTICS fixes. It’s rarely asked, which is exactly why a crisp answer stands out.</p>`)}
`,
  exercises: [
    { id: 'm4-stale', title: 'Stale statistics after a bulk load', setup: `DROP TABLE IF EXISTS import_rows;
CREATE TABLE import_rows (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, status text NOT NULL, payload text);
INSERT INTO import_rows (status, payload) SELECT 'error', 'x' FROM generate_series(1, 1000);
ANALYZE import_rows;   -- statistics say: every row is 'error'
INSERT INTO import_rows (status, payload)
SELECT CASE WHEN random() < 0.99 THEN 'ok' ELSE 'error' END, md5(g::text) FROM generate_series(1, 200000) g;`,
      check: { type: 'state', verify: async (t) => {
        t.need(await t.num(`SELECT count(*) FROM pg_class WHERE relname = 'import_rows'`) === 1, 'Press <b>Run setup</b> first.');
        const est = (await t.plan(`SELECT * FROM import_rows WHERE status = 'ok'`)).Plan['Plan Rows'];
        const act = await t.num(`SELECT count(*) FROM import_rows WHERE status = 'ok'`);
        t.need(Math.abs(est - act) / act < 0.2, `The planner still estimates ${est.toLocaleString()} rows for <code>status = 'ok'</code>, but there are ${act.toLocaleString()}.`);
        return `Estimate ${est.toLocaleString()} vs actual ${act.toLocaleString()} — the planner knows the data again.`;
      } },
      prompt: '<p><b>Run setup</b> loads 200k rows into a table whose statistics were collected when it held only <code>\'error\'</code> rows. Look at <code>EXPLAIN ANALYZE SELECT * FROM import_rows WHERE status = \'ok\'</code> — the estimate is way off. Fix the estimate.</p>',
      hint: '<p>One word, plus the table name.</p>',
      solution: `ANALYZE import_rows;`,
      teardown: 'DROP TABLE IF EXISTS import_rows;' },
    { id: 'm4-extstats', title: 'Teach the planner that Paris is in France', setup: `DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT stxname FROM pg_statistic_ext WHERE stxrelid = 'customers'::regclass LOOP
    EXECUTE 'DROP STATISTICS ' || quote_ident(r.stxname);
  END LOOP; END $$;
ANALYZE customers;`,
      check: { type: 'state', verify: async (t) => {
        const est = (await t.plan(`SELECT * FROM customers WHERE country = 'FR' AND city = 'Paris'`)).Plan['Plan Rows'];
        const act = await t.num(`SELECT count(*) FROM customers WHERE country = 'FR' AND city = 'Paris'`);
        t.need(Math.abs(est - act) / act < 0.3, `The planner estimates ${est} rows, and the actual count is ${act}. It still thinks country and city are independent.`);
        return `Estimate ${est} vs actual ${act}.`;
      } },
      prompt: '<p>Make the planner’s row estimate for <code>WHERE country = \'FR\' AND city = \'Paris\'</code> land within 30% of the real count. You can’t change the query — only what the planner knows.</p>',
      hint: '<p><code>CREATE STATISTICS name (dependencies) ON country, city FROM customers;</code> — then ANALYZE, because extended statistics are only filled in by ANALYZE.</p>',
      solution: `CREATE STATISTICS customers_country_city (dependencies) ON country, city FROM customers;
ANALYZE customers;` },
  ],
},
]});

/* ═══════════════════════ MODULE 5 — Indexing in practice ═══════════════════════ */
modules.push({ title: 'Indexing in practice', lessons: [
{
  id: 'composite', title: 'Composite indexes: column order is everything', minutes: 16,
  lede: 'If you’ve met B+ trees before, Postgres’s B-tree will look familiar. The practical skill is designing one index that serves the filter, the sort and the LIMIT together — and knowing which queries it can’t serve.',
  body: `
<p>A Postgres B-tree is a B+ tree: sorted leaf pages linked in both directions, each entry holding a key and a heap TID. Since Postgres 13, duplicate keys are deduplicated, so low-cardinality indexes are much smaller than they used to be. A B-tree serves <code>=</code>, ranges, <code>IN</code>, <code>IS NULL</code>, and ORDER BY in either direction.</p>
<p>A composite index on <code>(a, b)</code> is sorted by <code>a</code>, then by <code>b</code> within each <code>a</code>. Picture a phone book sorted by (last name, first name):</p>
${TABLE(['Query shape', 'Uses (a, b) well?'], [
  ['<code>a = ?</code>', 'Yes — a contiguous slice of the index'],
  ['<code>a = ? AND b = ?</code> / <code>a = ? AND b &gt; ?</code>', 'Yes — both columns narrow the slice'],
  ['<code>a = ? ORDER BY b</code> (+ LIMIT)', 'Yes — rows come out already sorted, and it can stop early'],
  ['<code>a &gt; ? AND b = ?</code>', 'Partly — the range on <code>a</code> scans a wide slice and checks <code>b</code> along the way'],
  ['<code>b = ?</code>', 'Traditionally no. Postgres 18’s <em>skip scan</em> can jump through each distinct <code>a</code> when there are few of them'],
])}
<p>The rule of thumb is often called <strong>ESR: Equality columns first, then the Sort column, then Range columns.</strong></p>
<h2>Index + ORDER BY + LIMIT = instant top-N</h2>
${S(`EXPLAIN ANALYZE
SELECT id, created_at, total_cents
FROM orders
WHERE customer_id = 42
ORDER BY created_at DESC
LIMIT 10;`)}
<p>With only an index on <code>customer_id</code> (or none), Postgres fetches every order for the customer, then sorts. With <code>(customer_id, created_at)</code> it reads the first 10 index entries and stops. For customer 1, with over a thousand orders, the difference is dramatic.</p>
<h2>Postgres 18 skip scan</h2>
${S(`CREATE INDEX lab_status_created_idx ON orders (status, created_at);
EXPLAIN ANALYZE SELECT count(*) FROM orders WHERE created_at >= '2026-06-29';
DROP INDEX lab_status_created_idx;`)}
<p>If the planner picks the index, look for <code>Index Searches: N</code> — one descent per distinct status. That’s skip scan using an index that doesn’t lead with the filtered column. Useful, but don’t design for it: an index that leads with your filter is still better.</p>
<h2>One composite or several single-column indexes?</h2>
<p>Postgres can combine single-column indexes with a <em>BitmapAnd</em>, but a composite index matching the query is usually faster and smaller than two separate ones. An index on <code>(a, b)</code> also makes an index on <code>(a)</code> redundant — keep that in mind for the “index cost” lesson.</p>
${QUIZ('q-composite', 'You have an index on <code>(country, city)</code>. Which query can it serve most efficiently?', ['<code>WHERE city = \'Pune\' ORDER BY country</code>', '<code>WHERE country = \'IN\' ORDER BY city LIMIT 20</code>', '<code>WHERE lower(country) = \'in\'</code>'], 1, 'Equality on the leading column, then ordering by the second column: exactly the index’s sort order, so it can stop after 20 entries. The first query doesn’t lead with country; the third wraps the column in a function.')}
${INTERVIEW(`<p>Expect: “Given <code>WHERE tenant_id = ? AND status = ? AND created_at &gt; ? ORDER BY created_at DESC LIMIT 50</code>, design the index.” Answer <code>(tenant_id, status, created_at)</code> and say why: equality columns first, then the range/sort column, and the LIMIT is served straight from the index.</p>`)}
`,
  exercises: [
    { id: 'm5-feed', title: 'A customer’s order feed with no Sort', setup: DROP_EXTRA('orders'),
      check: { type: 'state', verify: async (t) => {
        const nodes = t.nodes(await t.plan('SELECT id, created_at, total_cents FROM orders WHERE customer_id = 42 ORDER BY created_at DESC LIMIT 10'));
        t.need(!seqOn(nodes, 'orders'), 'Still a Seq Scan on orders.');
        t.need(!sorts(nodes).length, 'The plan still has a Sort node. The index has to deliver rows already in <code>created_at</code> order for one customer.');
        return 'No scan of the whole table, no sort — the index delivers the 10 rows directly.';
      } },
      prompt: '<p>Make this query use an index and have <strong>no Sort node</strong> in its plan:</p><pre style="margin:0 0 10px">SELECT id, created_at, total_cents FROM orders\nWHERE customer_id = 42 ORDER BY created_at DESC LIMIT 10</pre>',
      hint: '<p>Equality column first, sort column second: <code>(customer_id, created_at)</code>.</p>',
      solution: `CREATE INDEX orders_customer_created_idx ON orders (customer_id, created_at DESC);`,
      after: 'Plain ascending <code>(customer_id, created_at)</code> works too: B-trees can be read backwards. <code>DESC</code> in an index only matters for mixed directions, like <code>ORDER BY a ASC, b DESC</code>.' },
    { id: 'm5-esr', title: 'Equality first, range second', setup: DROP_EXTRA('orders'),
      check: { type: 'state', verify: async (t) => {
        const nodes = t.nodes(await t.plan(`SELECT count(*) FROM orders WHERE shipping_country = 'JP' AND created_at >= '2026-01-01'`));
        t.need(!seqOn(nodes, 'orders'), 'Still a Seq Scan on orders.');
        const used = idxUsed(nodes);
        t.need(used.length, 'No index is used.');
        const first = await t.val(`SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0] WHERE i.indexrelid = ${lit(used[0])}::regclass`);
        t.need(first === 'shipping_country', `The plan uses <code>${used[0]}</code>, which leads with <code>${first}</code>. With the range column first, the index scans every country’s rows since January. Lead with the equality column.`);
        return `The plan uses ${used[0]} (shipping_country, …). The equality narrows the scan, then the range.`;
      } },
      prompt: '<p>Create an index that serves</p><pre style="margin:0 0 10px">SELECT count(*) FROM orders\nWHERE shipping_country = \'JP\' AND created_at &gt;= \'2026-01-01\'</pre><p>with the columns in the right order. The checker confirms the plan uses an index <em>and</em> that the index leads with the right column.</p>',
      hint: '<p>ESR: the equality column (<code>shipping_country</code>) first, the range column (<code>created_at</code>) second.</p>',
      solution: `CREATE INDEX orders_country_created_idx ON orders (shipping_country, created_at);` },
  ],
},
{
  id: 'special-indexes', title: 'Partial, expression and covering indexes', minutes: 16,
  lede: 'Three variations that turn “add an index” into “add exactly the right index”: index an expression, index only some rows, or carry extra columns so the table is never touched.',
  body: `
<h2>Expression indexes</h2>
<p>Index the expression the query actually uses. Case-insensitive login is the classic example:</p>
${S(`EXPLAIN ANALYZE SELECT id FROM customers WHERE lower(email) = 'kenji.tanaka1234@gmail.com';`)}
<p>A plain index on <code>email</code> can’t help, because the query compares <code>lower(email)</code>. <code>CREATE INDEX ON customers (lower(email))</code> can — as long as the query uses exactly the same expression. (The <code>citext</code> type is the other option.)</p>
<h2>Partial indexes</h2>
<p>Index only the rows you query. For example, the fulfillment team constantly polls <em>pending</em> orders, which are about 1% of the table:</p>
${S(`CREATE INDEX lab_pending_idx ON orders (created_at) WHERE status = 'pending';
SELECT pg_size_pretty(pg_relation_size('lab_pending_idx')) AS partial_size,
       pg_size_pretty(pg_relation_size('orders_pkey'))     AS full_pk_size;
DROP INDEX lab_pending_idx;`)}
<p>A partial index is tiny, stays in cache, and costs nothing when other rows are written. The query’s WHERE clause must imply the index’s predicate, and the planner has to see that at plan time — literal constants work best. Partial <em>unique</em> indexes enforce rules like “one active subscription per customer” (Module 7).</p>
<h2>Covering indexes and index-only scans</h2>
<p>If every column a query needs is in the index, Postgres can skip the heap — but only for pages the visibility map marks <em>all-visible</em>. The others still need a heap visit to check visibility; that’s the <code>Heap Fetches</code> line. <code>INCLUDE</code> adds payload columns to the leaf entries without making them part of the key:</p>
${S(`CREATE INDEX lab_cust_cover ON orders (customer_id) INCLUDE (total_cents);
EXPLAIN (ANALYZE) SELECT customer_id, sum(total_cents) FROM orders WHERE customer_id BETWEEN 100 AND 200 GROUP BY customer_id;
VACUUM orders;
EXPLAIN (ANALYZE) SELECT customer_id, sum(total_cents) FROM orders WHERE customer_id BETWEEN 100 AND 200 GROUP BY customer_id;
DROP INDEX lab_cust_cover;`)}
<p>Compare <code>Heap Fetches</code> before and after VACUUM. On a busy table, autovacuum keeps the visibility map fresh; on write-heavy tables, index-only scans quietly degrade into index scans.</p>
${JOB(`<p>Before adding a covering index, check how wide it gets. Carrying three text columns makes a big index, and every write pays for it. Cover the hot query, not every query.</p>`)}
${INTERVIEW(`<p>“How would you index a soft-deleted table / a status queue / case-insensitive emails?” → partial on <code>deleted_at IS NULL</code>, partial on <code>status = 'pending'</code>, expression on <code>lower(email)</code>. Knowing these three by heart covers a surprising share of real indexing work.</p>`)}
`,
  exercises: [
    { id: 'm5-lower', title: 'Case-insensitive login lookup', setup: DROP_EXTRA('customers'),
      check: { type: 'state', verify: async (t) => {
        const nodes = t.nodes(await t.plan(`SELECT id FROM customers WHERE lower(email) = 'kenji.tanaka1234@gmail.com'`));
        t.need(!seqOn(nodes, 'customers'), 'The lookup on <code>lower(email)</code> still scans the whole customers table.');
        return 'Login lookups now use an index.';
      } },
      prompt: '<p>Make <code>SELECT id FROM customers WHERE lower(email) = \'kenji.tanaka1234@gmail.com\'</code> use an index. Don’t change the query.</p>',
      hint: '<p>Index the expression itself: <code>CREATE INDEX … ON customers (lower(email));</code></p>',
      solution: `CREATE INDEX customers_lower_email_idx ON customers (lower(email));` },
    { id: 'm5-partial', title: 'A tiny index for the pending queue', setup: DROP_EXTRA('orders'),
      check: { type: 'state', verify: async (t) => {
        const nodes = t.nodes(await t.plan(`SELECT id, customer_id, created_at FROM orders WHERE status = 'pending' ORDER BY created_at LIMIT 50`));
        t.need(!seqOn(nodes, 'orders'), 'Still a Seq Scan on orders.');
        t.need(!sorts(nodes).length, 'The plan still sorts. The index should deliver pending orders in created_at order.');
        const used = idxUsed(nodes); t.need(used.length, 'No index used.');
        const [partial, size] = (await t.rows(`SELECT indpred IS NOT NULL, pg_relation_size(indexrelid) FROM pg_index WHERE indexrelid = ${lit(used[0])}::regclass`))[0];
        t.need(partial === 't' || partial === true, `<code>${used[0]}</code> indexes every order. Make it partial, so it only contains pending ones.`);
        t.need(Number(size) < 1024 * 1024, `<code>${used[0]}</code> is ${(size / 1024).toFixed(0)} kB — should be well under 1 MB.`);
        return `${used[0]} is ${(size / 1024).toFixed(0)} kB — tiny, and exactly what the dashboard needs.`;
      } },
      prompt: '<p>The fulfillment dashboard polls this every few seconds:</p><pre style="margin:0 0 10px">SELECT id, customer_id, created_at FROM orders\nWHERE status = \'pending\' ORDER BY created_at LIMIT 50</pre><p>Build the smallest index that serves it with no Sort. It must be under 1 MB.</p>',
      hint: '<p>Key on <code>created_at</code> (the sort column), and add <code>WHERE status = \'pending\'</code> to the index definition.</p>',
      solution: `CREATE INDEX orders_pending_created_idx ON orders (created_at) WHERE status = 'pending';` },
    { id: 'm5-ios', title: 'Index-only scan with zero heap fetches', setup: `${DROP_EXTRA('orders')}
UPDATE orders SET total_cents = total_cents WHERE id % 50 = 0;   -- touches most pages`,
      check: { type: 'state', verify: async (t) => {
        const nodes = t.nodes(await t.plan(`SELECT customer_id, sum(total_cents) FROM orders WHERE customer_id BETWEEN 100 AND 200 GROUP BY customer_id`, true));
        const ios = nodes.find((n) => n['Node Type'] === 'Index Only Scan');
        t.need(ios, `No Index Only Scan in the plan (found: ${[...new Set(nodes.map((n) => n['Node Type']))].join(', ')}). The index must contain every column the query reads.`);
        t.need(Number(ios['Heap Fetches']) === 0, `Index Only Scan, but with ${ios['Heap Fetches']} heap fetches: the visibility map isn’t up to date for many pages.`);
        return `Index Only Scan on ${ios['Index Name']} with 0 heap fetches.`;
      } },
      prompt: '<p>Make</p><pre style="margin:0 0 10px">SELECT customer_id, sum(total_cents) FROM orders\nWHERE customer_id BETWEEN 100 AND 200 GROUP BY customer_id</pre><p>run as an <strong>Index Only Scan with Heap Fetches: 0</strong>. <b>Run setup</b> first: it also updates rows spread across most pages, the way a busy table looks.</p>',
      hint: '<p>(1) A covering index: <code>(customer_id) INCLUDE (total_cents)</code> or <code>(customer_id, total_cents)</code>. (2) Something has to mark the pages all-visible again.</p>',
      solution: `CREATE INDEX orders_customer_cover_idx ON orders (customer_id) INCLUDE (total_cents);
VACUUM orders;` },
  ],
},
{
  id: 'gin-brin', title: 'GIN, BRIN, GiST and trigram indexes', minutes: 18,
  lede: 'B-trees index one sortable value per row. When a row holds many searchable values (JSON keys, array elements, words) or the table is a giant time-ordered log, you need a different structure.',
  body: `
${TABLE(['Type', 'Idea', 'Use for'], [
  ['<b>B-tree</b>', 'Sorted keys', 'Almost everything: =, ranges, sorting, uniqueness'],
  ['<b>GIN</b>', 'Inverted index: each key → list of rows', '<code>jsonb</code> containment, arrays, full-text search, trigram LIKE. Slower writes (pending list)'],
  ['<b>GiST</b>', 'Balanced tree of bounding “shapes”', 'Ranges and overlaps, geometry/PostGIS, nearest-neighbour ORDER BY, exclusion constraints'],
  ['<b>BRIN</b>', 'Min/max summary per block range (128 pages)', 'Huge append-only tables where values follow physical order (time series, logs). Tiny'],
  ['<b>Hash</b>', 'Hash buckets', 'Equality only; rarely better than a B-tree'],
])}
<h2>jsonb and GIN</h2>
${S(`SELECT event_type, payload FROM events WHERE event_type = 'search' LIMIT 3;
EXPLAIN ANALYZE SELECT count(*) FROM events WHERE payload @> '{"q": "coffee"}';`)}
<p><code>@&gt;</code> means “contains”. A GIN index makes it fast. The default operator class, <code>jsonb_ops</code>, supports <code>@&gt;</code>, <code>?</code>, <code>?|</code> and <code>?&amp;</code>. <code>jsonb_path_ops</code> is smaller and faster but supports only <code>@&gt;</code> and jsonpath. Note that <code>payload-&gt;&gt;'q' = 'coffee'</code> is a <em>different</em> query shape: it needs a B-tree expression index on <code>(payload-&gt;&gt;'q')</code>.</p>
<h2>Full-text search</h2>
${S(`SELECT id, rating, body,
       ts_rank(to_tsvector('english', body), q) AS rank
FROM reviews, websearch_to_tsquery('english', 'battery drains') q
WHERE to_tsvector('english', body) @@ q
ORDER BY rank DESC
LIMIT 5;`)}
<p><code>to_tsvector</code> stems words (“drains” → “drain”) and drops stop words; <code>websearch_to_tsquery</code> accepts Google-style input. Index it with a GIN expression index, or with a stored generated <code>tsvector</code> column. When you need relevance tuning, facets, typo tolerance at scale or multi-language analyzers, that’s the point to consider OpenSearch/Elasticsearch.</p>
<h2>Trigram search for <code>LIKE '%…%'</code></h2>
${S(`CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXPLAIN ANALYZE SELECT count(*) FROM customers WHERE full_name ILIKE '%sharm%';
CREATE INDEX lab_name_trgm ON customers USING gin (full_name gin_trgm_ops);
EXPLAIN ANALYZE SELECT count(*) FROM customers WHERE full_name ILIKE '%sharm%';
SELECT full_name, similarity(full_name, 'Priya Sharmaa') FROM customers
WHERE full_name % 'Priya Sharmaa' LIMIT 3;   -- fuzzy match
DROP INDEX lab_name_trgm;`)}
<h2>BRIN: an index measured in kilobytes</h2>
${S(`SELECT correlation FROM pg_stats WHERE tablename = 'events' AND attname = 'occurred_at';
CREATE INDEX lab_events_brin ON events USING brin (occurred_at);
SELECT pg_size_pretty(pg_relation_size('lab_events_brin')) AS brin_size,
       pg_size_pretty(pg_relation_size('events'))          AS table_size;
EXPLAIN ANALYZE SELECT count(*) FROM events WHERE occurred_at >= '2026-03-01' AND occurred_at < '2026-03-02';
DROP INDEX lab_events_brin;`)}
<p>BRIN stores the min and max <code>occurred_at</code> for each run of 128 pages, and skips runs that can’t match. It only works because correlation is close to 1: events were appended in time order. Update or backfill rows out of order and BRIN degrades toward a seq scan. “Lossy” heap blocks and “Rows Removed by Index Recheck” are expected.</p>
${INTERVIEW(`<p>“How do you index a JSON column?” — say which operators you need (<code>@&gt;</code> → GIN; <code>-&gt;&gt;</code> equality → expression B-tree). “How do you build search?” — FTS for built-in stemmed search, trigram for substring/fuzzy, an external engine for relevance at scale. “Time-series in Postgres?” — BRIN plus time partitioning.</p>`)}
`,
  exercises: [
    { id: 'm5-gin', title: 'Index the search log (jsonb)', setup: DROP_EXTRA('events'),
      check: { type: 'state', verify: async (t) => {
        const nodes = t.nodes(await t.plan(`SELECT count(*) FROM events WHERE payload @> '{"q": "coffee"}'`));
        t.need(!seqOn(nodes, 'events'), 'Still a Seq Scan on events.');
        const used = idxUsed(nodes); t.need(used.length, 'No index used.');
        const am = await t.val(`SELECT am.amname FROM pg_class c JOIN pg_am am ON am.oid = c.relam WHERE c.oid = ${lit(used[0])}::regclass`);
        t.need(am === 'gin', `The plan uses ${used[0]}, a ${am} index. Containment on jsonb wants GIN.`);
        return `The plan uses GIN index ${used[0]}.`;
      } },
      prompt: '<p>Make <code>SELECT count(*) FROM events WHERE payload @&gt; \'{"q": "coffee"}\'</code> use an index. (Building it over 600k JSON documents takes a few seconds.)</p>',
      hint: '<p><code>CREATE INDEX … ON events USING gin (payload jsonb_path_ops);</code> — or the default <code>jsonb_ops</code>.</p>',
      solution: `CREATE INDEX events_payload_gin ON events USING gin (payload jsonb_path_ops);` },
    { id: 'm5-fts', title: 'Full-text search that uses an index', setup: DROP_EXTRA('reviews'),
      check: { type: 'state', verify: async (t) => {
        const nodes = t.nodes(await t.plan(`SELECT id FROM reviews WHERE to_tsvector('english', body) @@ websearch_to_tsquery('english', 'battery drains')`));
        t.need(!seqOn(nodes, 'reviews'), 'Still a Seq Scan on reviews — it computes to_tsvector for all 100k rows on every search.');
        return 'Search now uses an index instead of re-parsing every review.';
      } },
      prompt: '<p>Without changing the query, make</p><pre style="margin:0 0 10px">SELECT id FROM reviews\nWHERE to_tsvector(\'english\', body) @@ websearch_to_tsquery(\'english\', \'battery drains\')</pre><p>use an index.</p>',
      hint: '<p>A GIN index on the exact expression: <code>USING gin (to_tsvector(\'english\', body))</code>. The text search configuration (<code>\'english\'</code>) has to be written out, and must match the query.</p>',
      solution: `CREATE INDEX reviews_body_fts_idx ON reviews USING gin (to_tsvector('english', body));` },
    { id: 'm5-brin', title: 'The 100 kB index', setup: DROP_EXTRA('events'),
      check: { type: 'state', verify: async (t) => {
        const nodes = t.nodes(await t.plan(`SELECT count(*) FROM events WHERE occurred_at >= '2026-03-01' AND occurred_at < '2026-03-02'`));
        t.need(!seqOn(nodes, 'events'), 'Still a Seq Scan on events.');
        const used = idxUsed(nodes); t.need(used.length, 'No index used.');
        for (const u of used) {
          const size = await t.num(`SELECT pg_relation_size(${lit(u)}::regclass)`);
          t.need(size < 100 * 1024, `The plan uses ${u}, which is ${(size / 1e6).toFixed(1)} MB. The budget is 100 kB.`);
        }
        return `The plan uses ${used.join(', ')} — well under 100 kB.`;
      } },
      prompt: '<p>Make <code>SELECT count(*) FROM events WHERE occurred_at &gt;= \'2026-03-01\' AND occurred_at &lt; \'2026-03-02\'</code> avoid a Seq Scan, using an index <strong>smaller than 100 kB</strong>. (A B-tree on <code>occurred_at</code> would be over 10 MB.)</p>',
      hint: '<p>The events table is appended in time order.</p>',
      solution: `CREATE INDEX events_occurred_brin ON events USING brin (occurred_at);` },
  ],
},
{
  id: 'index-costs', title: 'Every index has a price', minutes: 14,
  lede: 'Adding an index is easy; knowing when to remove one is the harder skill. Every index slows down every write, takes memory and disk, and needs vacuuming. Unused and duplicate indexes cost you with nothing in return.',
  body: `
<h2>Measure the write tax</h2>
${S(`\\timing on
DROP TABLE IF EXISTS ins_test;
CREATE TABLE ins_test (id bigint, a int, b int, c text);
INSERT INTO ins_test SELECT g, g % 1000, g % 77, md5(g::text) FROM generate_series(1, 200000) g;
TRUNCATE ins_test;
CREATE INDEX ON ins_test (a);
CREATE INDEX ON ins_test (b);
CREATE INDEX ON ins_test (c);
INSERT INTO ins_test SELECT g, g % 1000, g % 77, md5(g::text) FROM generate_series(1, 200000) g;
DROP TABLE ins_test;`)}
<p>Compare the two INSERT timings. Each index is another B-tree to update per row, more WAL to write and replicate, and more pages competing for cache. Indexes on updated columns also block HOT updates (Module 3).</p>
<h2>Find indexes nobody uses</h2>
${S(`SELECT s.relname AS table, s.indexrelname AS index, s.idx_scan,
       pg_size_pretty(pg_relation_size(s.indexrelid)) AS size
FROM pg_stat_user_indexes s
ORDER BY s.idx_scan, pg_relation_size(s.indexrelid) DESC;`)}
${WARN(`<p>Before dropping an index with <code>idx_scan = 0</code>: statistics may have been reset recently, the index may be used <em>only on a replica</em> (every server has its own counters), or it may back a unique constraint. Check every node, over a full business cycle — month-end jobs exist.</p>`)}
<h2>Building indexes on a live table</h2>
<p>A plain <code>CREATE INDEX</code> takes a SHARE lock: reads continue, but <strong>all writes block</strong> until the build finishes. On a big table that can mean minutes of write downtime. <code>CREATE INDEX CONCURRENTLY</code> avoids that. Its trade-offs:</p>
<ul>
  <li>It scans the table twice and waits for older transactions, so it’s slower.</li>
  <li>It can’t run inside a transaction block.</li>
  <li>If it fails (say, a duplicate for a UNIQUE index), it leaves an <strong>INVALID</strong> index that still slows writes but is never used. Find it with <code>\\d</code> or <code>pg_index.indisvalid</code>, drop it, and retry.</li>
</ul>
${S(`CREATE INDEX CONCURRENTLY IF NOT EXISTS lab_cc_idx ON orders (shipping_country);
SELECT indexrelid::regclass, indisvalid, indisready FROM pg_index WHERE indexrelid = 'lab_cc_idx'::regclass;
DROP INDEX CONCURRENTLY lab_cc_idx;`)}
<p>Indexes also bloat under heavy update and delete churn. <code>REINDEX INDEX CONCURRENTLY</code> rebuilds one without blocking writes.</p>
<h2>Before adding an index, ask</h2>
<ol><li>Which query, how often, and how slow is it now?</li><li>Can an existing index be extended instead (<code>(a)</code> → <code>(a, b)</code>)?</li><li>How write-heavy is the table?</li><li>Could it be partial?</li></ol>
${QUIZ('q-cic', '<code>CREATE INDEX CONCURRENTLY</code> fails halfway through with a unique violation. What’s left behind?', ['Nothing — it rolls back cleanly', 'An INVALID index that is maintained on every write but never used for reads', 'A half-built index the planner will use for some queries'], 1, 'The catalog entry remains and is marked invalid. It still costs write overhead until you DROP it. This is a classic operational gotcha.')}
${INTERVIEW(`<p>“What are the downsides of adding indexes?” and “How would you add an index to a 500 GB table in production?” → CONCURRENTLY, off-peak, watch for an INVALID result, <code>lock_timeout</code> on any surrounding DDL, and check replication lag.</p>`)}
`,
  exercises: [
    { id: 'm5-unused', title: 'Find the dead weight', setup: `CREATE INDEX IF NOT EXISTS orders_coupon_code_idx ON orders (coupon_code);  -- "for a report", years ago`,
      check: { type: 'result', prepare: 'SELECT pg_stat_force_next_flush()' },
      prompt: '<p>List every <em>non-unique</em> index in the database that has <strong>never been scanned</strong> (<code>idx_scan = 0</code>). Columns: index name, table name, index size in bytes. <b>Run setup</b> first, so there’s at least one.</p>',
      hint: '<p>Join <code>pg_stat_user_indexes</code> (it has <code>indexrelname</code>, <code>relname</code>, <code>idx_scan</code>) to <code>pg_index</code> on <code>indexrelid</code> to filter <code>NOT indisunique</code>. Get the size with <code>pg_relation_size(indexrelid)</code>.</p>',
      solution: `SELECT s.indexrelname, s.relname, pg_relation_size(s.indexrelid)
FROM pg_stat_user_indexes s
JOIN pg_index i ON i.indexrelid = s.indexrelid
WHERE s.idx_scan = 0 AND NOT i.indisunique;` },
    { id: 'm5-redundant', title: 'Drop the redundant index', setup: `${DROP_EXTRA('orders')}
CREATE INDEX orders_cust_only_idx ON orders (customer_id);
CREATE INDEX orders_cust_created2_idx ON orders (customer_id, created_at);`,
      check: { type: 'state', verify: async (t) => {
        const dup = await t.rows(`SELECT a.indexrelid::regclass::text, b.indexrelid::regclass::text
          FROM pg_index a JOIN pg_index b ON a.indrelid = b.indrelid AND a.indexrelid <> b.indexrelid
          JOIN pg_class ca ON ca.oid = a.indexrelid JOIN pg_class cb ON cb.oid = b.indexrelid
          WHERE a.indrelid = 'orders'::regclass AND NOT a.indisunique AND a.indpred IS NULL AND b.indpred IS NULL
            AND a.indexprs IS NULL AND b.indexprs IS NULL AND ca.relam = cb.relam
            AND (b.indkey::text || ' ') LIKE (a.indkey::text || ' %')
            AND (a.indkey::text <> b.indkey::text OR a.indexrelid > b.indexrelid)`);
        t.need(dup.length === 0, `Still redundant: ${dup.map(([a, b]) => `<code>${a}</code> is covered by <code>${b}</code>`).join('; ')}.`);
        t.need(await t.num(`SELECT count(*) FROM pg_indexes WHERE tablename = 'orders' AND indexdef LIKE '%(customer_id, created_at%'`) >= 1, 'Keep the composite index — it serves both query shapes.');
        return 'No index on orders is a prefix of another. Writes got cheaper and nothing got slower.';
      } },
      prompt: '<p>After <b>Run setup</b>, <code>orders</code> has two indexes, and one of them is redundant because the other can serve every query it can. Remove the redundant one. (If you have other indexes on orders that are prefixes of another index, the checker will name them too.)</p>',
      hint: '<p>A B-tree on <code>(a, b)</code> serves any query that <code>(a)</code> alone could. Keep the composite.</p>',
      solution: `DROP INDEX orders_cust_only_idx;`,
      after: 'In production, use <code>DROP INDEX CONCURRENTLY</code>, and check the index’s <code>idx_scan</code> on every replica first.' },
  ],
},
]});

window.PGLAB_COURSE = { modules, quizzes, sims };
})();
