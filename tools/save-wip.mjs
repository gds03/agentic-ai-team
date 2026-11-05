#!/usr/bin/env node
// Saves the work of an interrupted agent run: commits everything in a worktree as a WIP commit and pushes it,
// so a usage limit or a crash never loses uncommitted work. Team tooling, no dependencies (Node 18+).
//
//   node tools/save-wip.mjs [path-to-worktree] [--item BL-0049] [--role qa] [--dry-run]
//
// Run it from the orchestrating session whenever an agent stops without its final report (usage limit, API
// error) and before removing or reusing its worktree. It never touches main, never force-pushes, and refuses
// to commit files that look like secrets. See "Checkpoints and interrupted runs" in CLAUDE.md.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const dryRun = args.includes('--dry-run') && args.splice(args.indexOf('--dry-run'), 1).length === 1;
const item = flag('--item');
const role = flag('--role') ?? 'agent';
const dir = resolve(args[0] ?? '.');

const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
const fail = (msg) => { console.error(`save-wip: ${msg}`); process.exit(1); };

let branch;
try { branch = git('rev-parse', '--abbrev-ref', 'HEAD'); } catch { fail(`${dir} is not a git worktree`); }
if (branch === 'HEAD') fail('detached HEAD: check out a branch first');
if (['main', 'master'].includes(branch)) fail(`refusing to commit on ${branch}`);

const status = git('status', '--porcelain', '-uall');
const ahead = (() => { try { return Number(git('rev-list', '--count', '@{u}..HEAD')); } catch { return -1; } })();

const secret = /(^|[\\/])(\.env(\..*)?|id_rsa.*|.*\.(pfx|p12|key|pem))$/i;
const changed = status.split('\n').filter(Boolean).map((l) => l.slice(3).replace(/^"|"$/g, ''));
const risky = changed.filter((p) => secret.test(p));
if (risky.length) fail(`not committing, these look like secrets: ${risky.join(', ')}`);

if (!status) {
  console.log(`save-wip: ${branch} has nothing uncommitted.`);
} else {
  const label = item ? `WIP ${item}` : 'WIP';
  const message = `${label}: checkpoint, ${role} run was interrupted (${changed.length} file${changed.length === 1 ? '' : 's'})`;
  console.log(`save-wip: ${changed.length} uncommitted file(s) on ${branch}:`);
  for (const p of changed.slice(0, 40)) console.log(`  ${p}`);
  if (changed.length > 40) console.log(`  ... and ${changed.length - 40} more`);
  if (dryRun) { console.log(`save-wip: dry run, would commit as "${message}"`); process.exit(0); }
  git('add', '-A');
  git('commit', '-m', message);
  console.log(`save-wip: committed "${message}"`);
}

if (dryRun) process.exit(0);
if (!status && ahead === 0) { console.log('save-wip: nothing to push.'); process.exit(0); }
try {
  git('push', '-u', 'origin', 'HEAD');
  console.log(`save-wip: pushed ${branch} to origin.`);
} catch (e) {
  fail(`committed locally but the push failed: ${String(e.stderr ?? e.message).trim()}`);
}
