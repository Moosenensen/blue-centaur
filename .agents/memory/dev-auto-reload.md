---
name: Dev auto-reload quirks
description: Why the dev workflow uses node --watch instead of nodemon, and post-merge restart expectations
---

The dev workflow (`npm run dev`) runs `node --watch -r ts-node/register src/index.ts`.

**Why:** nodemon crashes at runtime (`TypeError: minimatch is not a function`) because package.json `overrides` pins `minimatch` to ^10, whose API breaks nodemon's bundled expectations. Node's built-in `--watch` needs no glob library and reloads on any imported-module change.

**How to apply:** After task merges or code edits, the server reloads itself — no manual workflow restart needed for .ts changes. Static files under `src/web` are served from disk per request and never need a restart. If reload behavior seems broken, check the workflow logs before assuming stale code. Don't reintroduce nodemon for src watching unless the minimatch override situation changes.
