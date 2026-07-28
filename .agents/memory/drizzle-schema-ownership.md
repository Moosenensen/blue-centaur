---
name: Drizzle schema ownership
description: How the DB schema is managed (Drizzle, no startup DDL) and the jsonb-string insert gotcha.
---

# Drizzle is the schema source of truth

The DB schema lives in `src/database/schema.ts` (Drizzle). There is **no
startup-time DDL** — the app assumes the tables already exist. Do NOT
reintroduce `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ... ADD COLUMN` at boot.

**Why:** startup DDL self-heals prod and bypasses Replit's Publish-time schema
diff (which prompts the user to confirm renames, preventing drop+add data loss).

**How to apply:**
- Dev schema is applied by `scripts/post-merge.sh` running `db:push -- --force`
  after install. Prod is updated only via the user re-publishing (Publish diff).
- Column changes go in `schema.ts` + a migration plan, never via boot-time DDL.
- One shared pg Pool + Drizzle client in `src/database/db.ts`; don't spin up
  per-class `new Pool(...)`.

## `db:push` can't resolve renames non-interactively

`drizzle-kit push --force` still opens an **interactive TTY prompt** to decide
whether a changed column is a rename vs a drop+add — and `--force` does NOT
suppress it. In the agent shell there is no TTY, so it dies with "Interactive
prompts require a TTY terminal" *after* pulling the schema (leaving the DB
unchanged).

**Why:** a column rename is ambiguous to the differ; drop+add would silently
lose the column's data, so it insists a human confirm.

**How to apply:** when a schema change includes a rename, apply the exact DDL by
hand against the dev DB (via the `executeSql` code-exec callback):
`ALTER TABLE t RENAME COLUMN old TO new;` plus any ADD/DROP. Then run
`db:push -- --force` to confirm it reports "no changes" (schema.ts ⇄ DB in sync).
Prod still goes through the Publish diff, which prompts the user for the rename.

## Schema DDL does NOT propagate across isolated env DBs

Each task agent works on its own DB copy. A `schema.ts` change committed by another
task only altered **that task's** dev DB (manual DDL / db:push there). When you
rebase those commits in, your `schema.ts` now expects columns your DB doesn't have,
so every insert/update fails with `column "X" does not exist` and logging silently
breaks.

**Why:** the schema file travels with the code (git); the physical DDL does not.

**How to apply:** after any rebase that touches `schema.ts`, reconcile your dev DB —
run `db:push` and, for renames it can't do non-interactively, apply the DDL by hand
(read the originating commit's message; it documents the exact rename/add/drop). Find
the mapping by diffing `information_schema.columns` for the table against `schema.ts`;
a NOT-NULL added col that maps to a removed NOT-NULL col is almost always a rename,
not a drop+add. Confirm empty before dropping any removed column.

## jsonb pre-serialized-string insert gotcha

DecisionLogger keeps its JSON blobs as **pre-serialized strings** (a deliberate
memory win — lets the live object graphs GC immediately). When inserting these
into a Drizzle `jsonb` column, pass them via `sql\`${jsonString}::jsonb\``, NOT
as a plain value. Drizzle JSON.stringify's plain values, so a string would get
**double-encoded**. Raw pg tolerated the bare string (implicit text→jsonb cast);
Drizzle does not.
