# Postgres Lab

A hands-on PostgreSQL course that runs a real PostgreSQL 18 in your browser. It has 10 modules, 58 auto-checked exercises, quizzes, and live concurrency scenarios, all on a realistic ~2.35M-row e-commerce dataset. It covers SQL beyond joins, reading query plans, indexing, transactions and locking, schema design, running Postgres in production, and interview practice. Nothing to install: open the site and start typing SQL.

**Site:** https://anadi198.github.io/learn-pg/

The console has two engines. Switch between them at the top of the console:

| | In-browser (default) | Your Postgres |
|---|---|---|
| Runs on | PostgreSQL 18 compiled to WebAssembly ([PGlite](https://pglite.dev)), inside the tab | Your own PostgreSQL, through a small local helper (`bridge/`) |
| Works on | Any device, including phones | The computer running Postgres and the bridge |
| Connections | One | Sessions **A**, **B**, **C**, plus live two- and three-session scenarios |
| Stop button | Restarts the engine from your last snapshot | Cancels the query (`pg_cancel_backend`) |

## Using your own Postgres

1. Install PostgreSQL (18 recommended) and Node.js 18+.
2. Put your password in a pgpass file so tools can connect without prompting:
   - Windows: `%APPDATA%\postgresql\pgpass.conf`
   - macOS/Linux: `~/.pgpass` (then `chmod 600 ~/.pgpass`)

   Add one line: `localhost:5432:*:postgres:YOUR_PASSWORD`. Setting `PGPASSWORD` also works.
3. Start the bridge:
   ```
   cd bridge
   npm install
   npm start
   ```
   It creates a database called `pglab` and prints two links:
   - `http://localhost:8787` serves the lab from this folder, already paired.
   - The pairing link `https://anadi198.github.io/learn-pg/#pair=…` pairs the hosted site in this browser. You only need it once.
4. In the console, switch to **Your Postgres** and press **Load the dataset** (~20 s).

Configure it with `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGLAB_DATABASE` (default `pglab`), `PGLAB_PORT` (default `8787`), and `PGLAB_ORIGINS` (extra allowed page origins, comma-separated).

To collect query statistics on your own server, enable `pg_stat_statements` once and then restart Postgres:

```sql
ALTER SYSTEM SET shared_preload_libraries = 'pg_stat_statements';
```

**Security:** the bridge runs any SQL it receives as the pgpass user. It only listens on `127.0.0.1`, only answers the known page origins, and needs the pairing token (kept in `bridge/.pglab-token`, which is git-ignored). Stop it with Ctrl+C when you're done.

## Files

| Path | What |
|---|---|
| `index.html`, `styles.css`, `app.js` | The app: psql-style console (`\d`, `\dt+`, `\x`…), plan visualizer, grader, engine switch |
| `course.js`, `course2.js` | Lessons, exercises, quizzes, concurrency scenarios |
| `seed.js` / `seed.sql` | The dataset generator (in-browser / plain psql: `psql -v ON_ERROR_STOP=1 -f seed.sql`) |
| `bridge/` | The local helper for "Your Postgres" |
| `serve.mjs` | Optional static server (`node serve.mjs` → http://localhost:8765) |

## Development

Open the browser console on the lab and run `await pglabSelfTest()`. It runs every exercise's reference solution (plus known-wrong and alternative answers) through the grader, on whichever engine is selected.
