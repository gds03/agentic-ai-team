#!/usr/bin/env node
// Docs viewer: browse every .md of the project (backlog, specs, ADRs, research, ...) in the browser.
//
//   node tools/docs.mjs                  serve on http://127.0.0.1:4747
//   node tools/docs.mjs --open           ...and open it in the browser
//   node tools/docs.mjs --port 5000      other port
//
// One dropdown per area, shown as a tree (backlog children under their parent, ADRs under their
// backlog item); pick an item to jump into it. New, renamed or edited files show up on
// their own (the page polls the server every 2s), and links between .md files work in the viewer.
//
// Work in progress in other git worktrees shows up too, the same way tools/board.mjs does it: the
// first worktree of `git worktree list` is the base, and for every other worktree the .md files its
// branch added or changed (committed since the merge base, edited, or new) override the base copy or
// are added. Those entries carry a branch badge (and "uncommitted" when the worktree has uncommitted
// changes), "new on branch", the status drift ("done on branch, designed on main") and "also in
// <branch>" when two worktrees change one file (the first worktree's copy is shown). A toggle shows
// only them; links in a worktree's document open that worktree's copy first, then the base.
// Outside git, or with no other worktree, only this checkout is read, exactly as before.
//
// Every list row and every open document shows when the file was last written (its modified time on disk,
// in local time); the page updates it on its own, also when a file is saved without its text changing.
//
// Read-only, binds to localhost and answers only requests addressed to 127.0.0.1 or localhost; serves
// only .md files really inside the repository or one of its worktrees (symlinks and junctions leading
// out are refused). A git call that hangs is stopped after 10 s and that worktree is skipped.
// No dependencies, Node 18+. This is team tooling, not part of the product.

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const port = Number(opt('--port') ?? 4747);

// Order = order of the dropdowns. `match` decides which folder/file belongs to the area.
const AREAS = [
  { id: 'backlog', label: 'Backlog', dir: 'docs/backlog' },
  { id: 'specs', label: 'Specs', dir: 'docs/specs' },
  { id: 'adr', label: 'ADRs', dir: 'docs/adr' },
  { id: 'research', label: 'Research', dir: 'docs/research' },
  { id: 'other', label: 'Other', files: ['CLAUDE.md', 'docs/PLAN.md', 'docs/TEAM.md'] },
];
const SKIP_DIRS = new Set(['node_modules', '.git', 'bin', 'obj', '.board']); // lower case: compared case-insensitively

// ---------- scanning ----------
const posix = (p) => p.split(sep).join('/');
const isMd = (p) => p.toLowerCase().endsWith('.md');
// Windows and macOS file systems ignore case, so BIN/ and Node_Modules/ are skipped too.
const skipped = (segment) => SKIP_DIRS.has(segment.toLowerCase());
// The walk's rule: a .md file whose folders are neither dot folders nor SKIP_DIRS.
const listable = (p) => isMd(p) && p.split('/').slice(0, -1).every((s) => s && !skipped(s) && !s.startsWith('.'));
// Symlinks and junctions: a file counts only when its real path is inside the real path of its
// checkout (`realTop` = real(top), computed once per scan). False when the file does not exist.
const real = (p) => { try { return realpathSync.native(p); } catch { return null; } };
const within = (realTop, abs) => { const r = real(abs); return !!r && !!realTop && r.startsWith(realTop + sep); };
// Folder paths compared the way the OS does (case-insensitive on Windows).
const samePath = process.platform === 'win32' ? (p) => resolve(p).toLowerCase() : (p) => resolve(p);
// Area a path belongs to: a file directly in an area folder, one of the named files, else 'other'.
const areaOf = (p) => (AREAS.find((a) => (a.files ? a.files.includes(p) : p.startsWith(`${a.dir}/`) && !p.slice(a.dir.length + 1).includes('/'))) ?? AREAS.at(-1)).id;

function listMd(top, dir) {
  const abs = join(top, dir);
  let names;
  try { names = readdirSync(abs); } catch { return []; }
  return names.filter(isMd).sort().map((n) => `${dir}/${n}`);
}

function describe(top, path) {
  const abs = join(top, path);
  const text = readFileSync(abs, 'utf8');
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const fm = {};
  if (m) for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  const h1 = text.replace(/^---[\s\S]*?\r?\n---/, '').match(/^#\s+(.+)$/m);
  const file = path.split('/').pop().replace(/\.md$/i, '');
  const title = fm.title || (h1 && h1[1].trim()) || file;
  // Relations for the tree in the dropdowns: a backlog item names its parent; an ADR file name
  // (BL-NNNN-ADRNNNN-subject.md) names the backlog item it belongs to.
  let parent = fm.parent || '';
  if (!fm.id && !parent) { const adr = file.match(/^(BL-\d+)-ADR\d+/); if (adr) parent = adr[1]; }
  // priority as the board shows it (P2 when a backlog item names none); other documents have none
  return { path, ref: path, file, title, id: fm.id || '', kind: fm.kind || '', parent, status: fm.status || '', priority: fm.id ? fm.priority || 'P2' : '', mtime: statSync(abs).mtimeMs };
}

// Every .md the viewer lists in one checkout: the area folders and files, then any other .md outside
// dot folders (so .claude/worktrees is never read as part of the base), SKIP_DIRS and the folders in
// `nested` (other worktrees placed inside this one). Files whose real path leaves `top` are left out.
function scanTree(top, nested = new Set()) {
  const realTop = real(top);
  const areas = AREAS.map((a) => {
    const paths = (a.files ? a.files.filter((f) => existsSync(join(top, f))) : listMd(top, a.dir)).filter((p) => within(realTop, join(top, p)));
    return { id: a.id, label: a.label, items: paths.map((p) => describe(top, p)) };
  });
  // anything else with .md that no area claims (e.g. a README in a new folder) still gets a home
  const claimed = new Set(areas.flatMap((a) => a.items.map((i) => i.path)));
  const extra = [];
  (function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      // isDirectory() is false for symlinks and junctions, so the walk never follows them
      if (e.isDirectory()) { if (!skipped(e.name) && !e.name.startsWith('.') && !nested.has(samePath(join(dir, e.name)))) walk(join(dir, e.name)); }
      else if (isMd(e.name) && within(realTop, join(dir, e.name))) {
        const p = posix(relative(top, join(dir, e.name)));
        if (!claimed.has(p)) extra.push(describe(top, p));
      }
    }
  })(top);
  if (extra.length) areas.find((a) => a.id === 'other').items.push(...extra.sort((a, b) => a.path.localeCompare(b.path)));
  return areas;
}

// Same order as scanTree: area folders by file name, 'other' = the named files first, then the rest.
function sortArea(area) {
  const named = AREAS.find((a) => a.id === area.id).files;
  if (!named) { area.items.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0)); return; }
  const rank = (p) => { const n = named.indexOf(p); return n < 0 ? named.length : n; };
  area.items.sort((x, y) => rank(x.path) - rank(y.path) || x.path.localeCompare(y.path));
}

// ---------- worktrees (the approach of tools/board.mjs) ----------
// Asynchronous, so the git calls of all worktrees run side by side and the server stays responsive.
// A git that hangs (a worktree on a network drive that went away, a lock) is killed after 10 s; the
// call then fails like any other and the caller skips that worktree.
const GIT_TIMEOUT_MS = 10000;
const git = (cwd, ...a) => new Promise((ok, fail) => execFile('git', a, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 64 << 20, timeout: GIT_TIMEOUT_MS }, (e, out) => (e ? fail(e) : ok(out))));

// The last list git gave us: used when `git worktree list` fails or times out in a repository that
// had worktrees a moment ago, so a slow git does not turn every worktree's document into a 404.
let lastWorktrees = null;
async function listWorktrees() {
  try {
    lastWorktrees = (await git(root, 'worktree', 'list', '--porcelain')).trim().split(/\r?\n\r?\n/).map((block) => {
      const path = block.match(/^worktree (.+)$/m)?.[1];
      if (!path || /^bare$/m.test(block)) return null;
      return { path: resolve(path), branch: block.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? '(detached)', head: block.match(/^HEAD (\w+)$/m)?.[1] };
    }).filter(Boolean);
    return lastWorktrees;
  } catch {
    return lastWorktrees ?? []; // not a git repository (or git failed before it ever answered)
  }
}

// The base (first worktree, or this checkout outside git / with no other worktree) and the other
// worktrees, each with a key for URLs: its branch name (git forbids ':' and '~' in branch names, so
// the 'key:path' refs the page uses stay unambiguous and the '~n' suffix cannot clash with a branch).
async function worktrees() {
  const wts = (await listWorktrees()).filter((w) => existsSync(w.path));
  if (wts.length < 2) return { base: { path: root, branch: '', head: '' }, others: [], nested: new Set() };
  const [base, ...rest] = wts;
  const nested = new Set(rest.map((w) => samePath(w.path))); // never walked as part of another checkout
  const used = new Set();
  const others = rest.map((w) => {
    let key = w.branch === '(detached)' ? `detached-${(w.head ?? '').slice(0, 7)}` : w.branch;
    for (let n = 2; used.has(key); n++) key = `${key.replace(/~\d+$/, '')}~${n}`;
    used.add(key);
    return { ...w, key };
  });
  return { base, others, nested };
}

// .md paths a worktree changed relative to the base: committed since the merge base with the base's
// HEAD, edited, or new and untracked (as board.mjs). `paths` is null when the histories share no
// commit; then every file counts. `uncommitted` holds the paths with uncommitted changes.
// Starting git costs ~50 ms on Windows, so what only depends on commits (the merge base, the files the
// branch's commits changed) is remembered: those commits never change. Each poll then runs one
// `git status` per worktree. Only answers are remembered: when compute fails (git timed out, a lock),
// nothing is stored, the worktree is skipped for this poll and the next poll asks again.
const memo = new Map();
async function once(key, compute) {
  if (!memo.has(key)) { const value = await compute(); if (memo.size > 1000) memo.clear(); memo.set(key, value); }
  return memo.get(key);
}
async function changedFiles(wt, base) {
  const from = await once(`base:${wt.head}:${base.head}`, async () => {
    try { return (await git(wt.path, 'merge-base', 'HEAD', base.head)).trim() || null; }
    catch (e) { if (e.code === 1 && !e.killed && !e.signal) return null; throw e; } // exit code 1 = no common ancestor (unrelated history)
  });
  // one `git status` gives the dirty flag, the edited files and the untracked ones (like `ls-files --others`)
  const [statusOut, committed] = await Promise.all([
    git(wt.path, 'status', '--porcelain', '-uall', '-z'),
    from ? once(`diff:${from}:${wt.head}`, () => git(wt.path, 'diff', '--name-only', '-z', from, wt.head, '--')) : '',
  ]);
  const status = statusOut.split('\0');
  const uncommitted = new Set();
  for (let i = 0; i < status.length; i++) {
    const e = status[i];
    if (!e) continue;
    uncommitted.add(e.slice(3));
    if (/[RC]/.test(e.slice(0, 2))) i++; // a rename or copy is followed by its old path
  }
  const dirty = uncommitted.size > 0;
  if (!from) return { dirty, uncommitted, paths: null };
  return { dirty, uncommitted, paths: new Set([...committed.split('\0').filter(Boolean), ...uncommitted]) };
}

// Documents of the base, overridden or extended by what each other worktree is changing. Scanned
// once per request, so worktrees added or removed while the viewer runs are picked up by the next poll.
async function scan() {
  const { base, others, nested } = await worktrees();
  // git for every worktree at once; a worktree that is gone, broken or too slow is skipped (null)
  const changes = await Promise.all(others.map((wt) => changedFiles(wt, base).catch(() => null)));
  const areas = scanTree(base.path, nested);
  const byPath = new Map(areas.flatMap((a) => a.items.map((i) => [i.path, i])));
  const list = [];
  for (const [n, wt] of others.entries()) {
    const changed = changes[n];
    if (!changed) continue;
    const info = { key: wt.key, branch: wt.branch, path: posix(wt.path), dirty: changed.dirty, count: 0 };
    list.push(info);
    const realTop = real(wt.path);
    const paths = changed.paths
      ? [...changed.paths].filter((p) => listable(p) && within(realTop, join(wt.path, p))) // exists, and not through a junction out of the worktree
      : scanTree(wt.path, nested).flatMap((a) => a.items.map((i) => i.path));
    for (const p of paths.sort()) {
      info.count++; // documents this worktree changes, including the ones another worktree shows
      const shown = byPath.get(p);
      if (shown?.wt) { shown.conflict = [...(shown.conflict ?? []), wt.branch]; continue; } // first worktree wins
      let doc;
      try { doc = describe(wt.path, p); } catch { continue; } // removed between the git call and now
      const item = { ...doc, ref: `${wt.key}:${p}`, wt: wt.key, inBase: !!shown, baseStatus: shown?.status ?? '', uncommitted: changed.uncommitted.has(p) };
      const area = areas.find((a) => a.id === areaOf(p));
      if (shown) area.items.splice(area.items.indexOf(shown), 1, item); else area.items.push(item);
      byPath.set(p, item);
    }
  }
  if (list.length) areas.forEach(sortArea);
  const version = areas.flatMap((a) => a.items).map((i) => `${i.ref}:${i.mtime}:${i.baseStatus ?? ''}:${i.uncommitted ?? ''}:${i.conflict ?? ''}`).join('|') +
    `#${JSON.stringify(list.map((w) => [w.key, w.path, w.dirty, w.count]))}`;
  return { areas, version, base: list.length ? { branch: base.branch, path: posix(base.path) } : null, worktrees: list };
}

// The folder to serve a file from: the base, or the worktree with that key (null when there is none).
async function topFor(key) {
  const { base, others } = await worktrees();
  return key ? others.find((w) => w.key === key)?.path ?? null : base.path;
}

// ---------- server ----------
const send = (res, code, type, body) => { res.writeHead(code, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' }); res.end(body); };
// Only requests addressed to this server by name: a web page on another site that points its own host
// name at 127.0.0.1 (DNS rebinding) sends its name in Host and is refused.
const HOSTS = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

const server = createServer(async (req, res) => {
  if (!HOSTS.has((req.headers.host ?? '').toLowerCase())) return send(res, 403, 'text/plain', 'forbidden host');
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/') return send(res, 200, 'text/html', PAGE);
    if (url.pathname === '/api/index') return send(res, 200, 'application/json', JSON.stringify(await scan()));
    if (url.pathname === '/api/file') {
      // ?path=<repo-relative .md>[&wt=<worktree key>]: only .md files inside the base or a listed worktree
      const rel = url.searchParams.get('path') ?? '';
      const top = await topFor(url.searchParams.get('wt') ?? '');
      if (!top) return send(res, 404, 'text/plain', 'no such worktree');
      const abs = resolve(top, rel);
      if (!isMd(rel) || !abs.startsWith(top + sep) || relative(top, abs).split(sep).some(skipped)) return send(res, 403, 'text/plain', 'forbidden');
      if (!existsSync(abs)) return send(res, 404, 'text/plain', 'not found');
      if (!within(real(top), abs)) return send(res, 403, 'text/plain', 'forbidden'); // a symlink or junction leading out
      try { return send(res, 200, 'text/plain', readFileSync(abs, 'utf8')); } catch { return send(res, 404, 'text/plain', 'not found'); }
    }
    send(res, 404, 'text/plain', 'not found');
  } catch (e) {
    send(res, 500, 'text/plain', e.message);
  }
});

server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${port} is busy (is the docs viewer already running? try --port <n>)` : e.message);
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  const addr = `http://127.0.0.1:${port}/`;
  console.log(`Docs viewer on ${addr} (Ctrl+C to stop)`);
  if (args.includes('--open')) {
    const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', addr]] : process.platform === 'darwin' ? ['open', [addr]] : ['xdg-open', [addr]];
    spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref();
  }
});

// ---------- page ----------
const PAGE = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Project docs</title>
<style>
:root{--bg:#f6f7f9;--panel:#fff;--ink:#1c2230;--muted:#667085;--line:#e2e5ea;--accent:#2f5bea;--code:#f0f2f5;--quote:#c9d3f5;--bad:#c4382f;--warn:#a96a00}
@media(prefers-color-scheme:dark){:root{--bg:#14171d;--panel:#1c2028;--ink:#e6e9ef;--muted:#98a2b3;--line:#2b313c;--accent:#7b9bff;--code:#252b35;--quote:#3a4a86;--bad:#f0706a;--warn:#e0a63c}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
header{position:sticky;top:0;z-index:5;background:var(--panel);border-bottom:1px solid var(--line);padding:10px 16px;display:flex;flex-wrap:wrap;gap:10px 14px;align-items:flex-end}
header h1{font-size:16px;margin:0 6px 6px 0;align-self:center}
.pick{position:relative;display:flex;flex-direction:column;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;min-width:0}
.pick .dd{margin-top:2px;display:flex;align-items:center;justify-content:space-between;gap:10px;width:min(300px,80vw);font:14px system-ui,sans-serif;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px 12px;text-transform:none;letter-spacing:0;cursor:pointer;text-align:left}
.pick .ddt{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.pick .car{flex:none;color:var(--muted)}
.pick.active .dd,.pick.open .dd{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
.panel{position:absolute;top:100%;left:0;z-index:30;margin-top:6px;width:min(780px,92vw);max-height:min(72vh,640px);overflow:auto;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:8px;box-shadow:0 12px 32px rgba(0,0,0,.22);text-transform:none;letter-spacing:0;color:var(--ink)}
.panel[hidden]{display:none}
.row{display:flex;align-items:baseline;gap:12px;padding:10px 14px;border-radius:8px;font:15px/1.35 system-ui,sans-serif;cursor:pointer;outline:none}
.row:hover,.row:focus{background:var(--code)}
.row.sel{background:color-mix(in srgb,var(--accent) 14%,transparent);box-shadow:inset 3px 0 0 var(--accent)}
.row .tree{flex:none;white-space:pre;font:14px ui-monospace,Consolas,monospace;color:var(--muted)}
.row .name{flex:1;min-width:0;overflow-wrap:anywhere}
.row .name b{font-weight:650}
.row .st{flex:none;font-size:11px;padding:2px 9px;border-radius:999px;background:var(--code);color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.row .when{flex:none;font:12px ui-monospace,Consolas,monospace;color:var(--muted);white-space:nowrap}
.written{font-size:12px;color:var(--muted);margin:4px 0 0}.written b{font-weight:600;color:inherit}
.row .prio{flex:none;font-size:10px;font-weight:700;border-radius:4px;padding:1px 5px;border:1px solid var(--line);color:var(--muted)}
.row .p-P0{color:var(--bad);border-color:var(--bad)}.row .p-P1{color:var(--warn);border-color:var(--warn)}
.find{position:sticky;top:-8px;z-index:1;margin:-8px -8px 6px;padding:10px 8px 8px;background:var(--panel);border-bottom:1px solid var(--line)}
.find input{width:100%;font:14px system-ui,sans-serif;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px 12px;outline:none}
.find input:focus{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
.row[hidden],.grp[hidden]{display:none}
.nomatch{padding:14px;color:var(--muted);font-size:14px}
.row .st-done{color:#2e9e66}.row .st-in-progress,.row .st-in-review,.row .st-in-qa{color:var(--accent)}
.grp{padding:12px 14px 4px;font:600 12px system-ui,sans-serif;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}
.grp:not(:first-child){border-top:1px solid var(--line);margin-top:6px}
.live{margin-left:auto;font-size:12px;color:var(--muted);align-self:center}
.flags{display:flex;flex-wrap:wrap;gap:4px}
.row .flags{margin-top:4px}
.flag{font:500 11px/1.5 system-ui,sans-serif;border-radius:4px;padding:0 6px;white-space:nowrap;text-transform:none;letter-spacing:0}
.flag.wt{background:color-mix(in srgb,var(--accent) 15%,transparent);color:var(--accent)}
.flag.warn{background:color-mix(in srgb,var(--warn) 15%,transparent);color:var(--warn)}
.flag.bad{background:color-mix(in srgb,var(--bad) 15%,transparent);color:var(--bad)}
.wts{flex-basis:100%;display:flex;flex-wrap:wrap;gap:6px 8px;align-items:center;font-size:12px;color:var(--muted)}
.wts[hidden]{display:none}
.wts label{display:flex;align-items:center;gap:5px;color:var(--ink);cursor:pointer;margin-right:6px}
.doc-flags{margin:6px 0 0}
main{max-width:1700px;margin:0 auto;padding:20px 16px 80px}
article{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:8px 28px 28px;overflow-wrap:anywhere}
.epiclink{margin:14px 0 0;font-size:13px}
.path{font:12px ui-monospace,Consolas,monospace;color:var(--muted);margin:10px 0 0}
.fm{border:1px solid var(--line);border-radius:8px;margin:14px 0;font-size:13px;overflow:hidden}
.fm div{display:flex;gap:10px;padding:4px 10px;border-top:1px solid var(--line)}.fm div:first-child{border-top:0}
.fm b{flex:0 0 120px;color:var(--muted);font-weight:500}
h1,h2,h3,h4{line-height:1.3;margin:1.6em 0 .5em}h1{font-size:1.7em;margin-top:.8em}h2{font-size:1.35em;border-bottom:1px solid var(--line);padding-bottom:.2em}h3{font-size:1.1em}
a{color:var(--accent)}
code{background:var(--code);padding:.1em .35em;border-radius:4px;font:.88em ui-monospace,Consolas,monospace}
pre{background:var(--code);padding:12px 14px;border-radius:8px;overflow:auto}pre code{background:none;padding:0}
#doc details{margin:1em 0;padding:.4em 1em;border:1px solid var(--quote);border-radius:6px}
#doc details>summary{cursor:pointer;font-weight:600}
blockquote{margin:1em 0;padding:.1em 1em;border-left:4px solid var(--quote);color:var(--muted)}
table{border-collapse:collapse;display:block;overflow:auto;margin:1em 0}th,td{border:1px solid var(--line);padding:5px 10px;text-align:left;vertical-align:top}th{background:var(--code)}
hr{border:0;border-top:1px solid var(--line);margin:1.6em 0}
img{max-width:100%}ul,ol{padding-left:1.5em}li.task{list-style:none;margin-left:-1.3em}li.task input{margin-right:.5em}
.empty{color:var(--muted);padding:40px 0;text-align:center}
</style></head><body>
<header><h1>Project docs</h1><div id="picks"></div><span class="live" id="live">connecting…</span><div class="wts" id="wts" hidden></div></header>
<main><article id="doc"><p class="empty">Pick a document from one of the lists above.</p></article></main>
<script>
const $=(s)=>document.querySelector(s);
const esc=(s)=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
let index=null,current=null,currentText=null;
// current is a ref: 'docs/x.md' for the base copy, '<worktree key>:docs/x.md' for a worktree's copy
let onlyWt=localStorage.getItem('docs.onlyWt')==='1';
const all=()=>index.areas.flatMap(a=>a.items);
// when a file was last written: local time, and how long ago (the ago texts refresh every 30s)
const pad=(n)=>String(n).padStart(2,'0');
function fmtAt(ms){const d=new Date(ms);return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+' '+pad(d.getHours())+':'+pad(d.getMinutes())}
function fmtAgo(ms){const s=Math.max(0,Math.round((Date.now()-ms)/1000));if(s<60)return 'just now';const m=Math.floor(s/60);if(m<60)return m+' min ago';const h=Math.floor(m/60);if(h<24)return h+' h ago';const d=Math.floor(h/24);return d+(d===1?' day ago':' days ago')}
setInterval(()=>document.querySelectorAll('[data-ago]').forEach(e=>{e.textContent=fmtAgo(+e.dataset.ago)}),30000);
const splitRef=(ref)=>{const k=ref.indexOf(':');return k<0?{wt:'',path:ref}:{wt:ref.slice(0,k),path:ref.slice(k+1)}};
const itemOf=(ref)=>index&&all().find(i=>i.ref===ref);

// ---------- worktree badges (as on the board) ----------
const wtOf=(i)=>i&&i.wt?index.worktrees.find(w=>w.key===i.wt):null;
function drift(i){
  if(!i.wt)return '';
  if(!i.inBase)return 'new on branch';
  return i.id&&i.baseStatus&&i.status!==i.baseStatus?i.status+' on branch, '+i.baseStatus+' on '+(index.base.branch||'base'):'';
}
function flags(i,inDoc){
  const w=wtOf(i);if(!w)return '';
  const d=drift(i);
  return '<span class="flag wt" title="'+esc(w.path)+(w.dirty?' (uncommitted changes)':'')+'">⎇ '+esc(w.branch)+(w.dirty?' · ● uncommitted':'')+'</span>'+
    (inDoc&&i.uncommitted?'<span class="flag warn">this file is not committed yet</span>':'')+
    (d?'<span class="flag warn">'+esc(d)+'</span>':'')+
    (i.conflict?'<span class="flag bad">also in '+esc(i.conflict.join(', '))+'</span>':'');
}
// The list of other worktrees and the "only in other worktrees" toggle; hidden when there are none.
function buildWts(){
  const el=$('#wts');
  if(!index.worktrees.length){el.hidden=true;el.innerHTML='';return}
  el.hidden=false;
  el.innerHTML='<label title="Show only documents that other worktrees add or change"><input type="checkbox" id="onlywt"'+(onlyWt?' checked':'')+'> Only in other worktrees</label>'+
    '<span>base ⎇ '+esc(index.base.branch||'(detached)')+' · other worktrees:</span>'+
    index.worktrees.map(w=>'<span class="flag wt" title="'+esc(w.path)+'">⎇ '+esc(w.branch)+' · '+w.count+' doc'+(w.count===1?'':'s')+(w.dirty?' · ● uncommitted':'')+'</span>').join('');
  $('#onlywt').onchange=(e)=>{onlyWt=e.target.checked;localStorage.setItem('docs.onlyWt',onlyWt?'1':'0');buildPicks()};
}

// ---------- markdown ----------
function inline(s){
  const codes=[];
  s=s.replace(/(\x60+)([\s\S]*?[^\x60])\1(?!\x60)/g,(_,__,c)=>{codes.push('<code>'+esc(c.trim())+'</code>');return '\u0000'+(codes.length-1)+'\u0000'});
  s=esc(s);
  s=s.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g,(_,a,u)=>'<img alt="'+a+'" src="'+u+'">');
  s=s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g,(_,t,u)=>'<a href="'+u+'">'+t+'</a>');
  s=s.replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g,'<a href="$1">$1</a>');
  s=s.replace(/\*\*([^*]+)\*\*|__([^_]+)__/g,(_,a,b)=>'<strong>'+(a||b)+'</strong>');
  s=s.replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g,'$1<em>$2</em>').replace(/(^|[^_\w])_([^_\s][^_]*)_(?!\w)/g,'$1<em>$2</em>');
  s=s.replace(/~~([^~]+)~~/g,'<del>$1</del>');
  return s.replace(/\u0000(\d+)\u0000/g,(_,i)=>codes[+i]);
}
function cells(l){return l.trim().replace(/^\|/,'').replace(/\|$/,'').replace(/\x60[^\x60]*\x60/g,c=>c.replace(/\|/g,'\u0001')).split(/(?<!\\)\|/).map(c=>c.trim().replace(/\\\|/g,'|').replace(/\u0001/g,'|'))}
function md(src){
  const L=src.replace(/\r\n?/g,'\n').split('\n');let out='';let i=0;
  const isBlock=(l)=>/^(#{1,6}\s|\s*([-*+]|\d+[.)])\s|>|\s*\x60{3}|\s*([-*_]\s*){3,}$|\s*\|)/.test(l);
  function list(indent){
    const first=L[i].match(/^(\s*)([-*+]|\d+[.)])\s/);const ordered=/\d/.test(first[2]);
    let h=ordered?'<ol>':'<ul>';
    while(i<L.length){
      const m=L[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
      if(!m||m[1].length!==indent||/\d/.test(m[2])!==ordered)break;
      let text=m[3];i++;
      const task=text.match(/^\[([ xX])\]\s+(.*)$/);
      let body=task?task[2]:text;
      while(i<L.length&&L[i].trim()&&!/^\s*([-*+]|\d+[.)])\s/.test(L[i])&&/^\s+\S/.test(L[i])){body+=' '+L[i].trim();i++}
      let sub='';
      while(i<L.length&&/^\s*([-*+]|\d+[.)])\s/.test(L[i])&&L[i].match(/^(\s*)/)[1].length>indent){sub+=list(L[i].match(/^(\s*)/)[1].length)}
      h+=task?'<li class="task"><input type="checkbox" disabled'+(task[1]!==' '?' checked':'')+'>'+inline(body)+sub+'</li>':'<li>'+inline(body)+sub+'</li>';
      if(i<L.length&&!L[i].trim()&&i+1<L.length&&new RegExp('^\\s{'+indent+'}([-*+]|\\d+[.)])\\s').test(L[i+1])&&L[i+1].match(/^(\s*)/)[1].length===indent)i++;
    }
    return h+(ordered?'</ol>':'</ul>');
  }
  while(i<L.length){
    const l=L[i];
    if(!l.trim()){i++;continue}
    let m;
    if(m=l.match(/^\s*<details(\s+open)?\s*>\s*$/i)){
      // collapsible block: <details> [<summary>title</summary>] markdown </details> (nesting not supported)
      const open=!!m[1];i++;const buf=[];while(i<L.length&&!/^\s*<\/details>\s*$/i.test(L[i]))buf.push(L[i++]);i++;
      let title='Details';const s=buf.findIndex(x=>/<summary>/i.test(x));
      if(s>=0){const t=buf[s].match(/<summary>(.*?)<\/summary>/i);if(t){title=t[1];buf.splice(s,1)}}
      out+='<details'+(open?' open':'')+'><summary>'+inline(title)+'</summary>'+md(buf.join('\n'))+'</details>';continue}
    if(m=l.match(/^\s*(\x60{3,}|~{3,})\s*(\S*)/)){const f=m[1];i++;const buf=[];while(i<L.length&&!L[i].trim().startsWith(f))buf.push(L[i++]);i++;out+='<pre><code>'+esc(buf.join('\n'))+'</code></pre>';continue}
    if(m=l.match(/^(#{1,6})\s+(.*?)\s*#*$/)){out+='<h'+m[1].length+'>'+inline(m[2])+'</h'+m[1].length+'>';i++;continue}
    if(/^\s*([-*_]\s*){3,}$/.test(l)){out+='<hr>';i++;continue}
    if(l.startsWith('>')){const buf=[];while(i<L.length&&L[i].startsWith('>'))buf.push(L[i++].replace(/^>\s?/,''));out+='<blockquote>'+md(buf.join('\n'))+'</blockquote>';continue}
    if(l.trim().startsWith('|')&&i+1<L.length&&/^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(L[i+1])){
      const head=cells(l);i+=2;let t='<table><thead><tr>'+head.map(c=>'<th>'+inline(c)+'</th>').join('')+'</tr></thead><tbody>';
      while(i<L.length&&L[i].trim().startsWith('|'))t+='<tr>'+cells(L[i++]).map(c=>'<td>'+inline(c)+'</td>').join('')+'</tr>';
      out+=t+'</tbody></table>';continue}
    if(/^\s*([-*+]|\d+[.)])\s/.test(l)){out+=list(l.match(/^(\s*)/)[1].length);continue}
    const buf=[l];i++;while(i<L.length&&L[i].trim()&&!isBlock(L[i]))buf.push(L[i++]);
    out+='<p>'+inline(buf.join('\n')).replace(/\n/g,' ')+'</p>';
  }
  return out;
}
// Where a link to a .md path goes from a document in worktree wt: that worktree's copy if it changes
// the file, else the base copy, else (a file only another worktree has) that worktree's copy.
function linkRef(path,wt){
  const items=index?all():[];
  if(wt&&items.some(i=>i.wt===wt&&i.path===path))return wt+':'+path;
  if(items.some(i=>i.path===path&&(!i.wt||i.inBase)))return path;
  const other=items.find(i=>i.path===path);
  return other?other.ref:path;
}
function render(text,ref){
  const {wt,path}=splitRef(ref);
  let fm='';
  const m=text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if(m){fm='<div class="fm">'+m[1].split(/\r?\n/).map(l=>{const kv=l.match(/^([A-Za-z_]+):\s*(.*)$/);return kv?'<div><b>'+esc(kv[1])+'</b><span>'+esc(kv[2])+'</span></div>':''}).join('')+'</div>';text=m[2]}
  const el=$('#doc');
  // a story whose parent is an epic gets a link to that epic on top
  const me=itemOf(ref);
  const epic=me&&me.parent&&all().find(i=>i.id===me.parent&&(i.kind==='EPIC'||/^BL-\d+-EPIC-/.test(i.file)));
  const up=epic?'<p class="epiclink">↑ Epic: <a class="epic" href="#'+encodeURIComponent(epic.ref)+'">'+esc(epic.id+' · '+epic.title)+'</a></p>':'';
  const badges=me?flags(me,true):'';
  el.innerHTML=up+'<p class="path">'+esc(path)+'</p>'+(badges?'<div class="flags doc-flags">'+badges+'</div>':'')+(me&&me.mtime?'<p class="written">Last written <b>'+fmtAt(me.mtime)+'</b> · <span data-ago="'+me.mtime+'">'+fmtAgo(me.mtime)+'</span></p>':'')+fm+md(text);
  // links to other .md files stay inside the viewer; other relative links are shown as text
  const base=path.split('/').slice(0,-1);
  el.querySelectorAll('a[href]:not(.epic)').forEach(a=>{
    const h=a.getAttribute('href');
    if(/^(https?:|mailto:)/.test(h)){a.target='_blank';a.rel='noopener';return}
    const [file,hash]=h.split('#');
    if(!file){a.setAttribute('href','#'+encodeURIComponent(ref)+(hash?'/'+hash:''));return}
    const parts=file.startsWith('/')?[]:base.slice();
    for(const p of decodeURI(file).split('/')){if(p==='..')parts.pop();else if(p&&p!=='.')parts.push(p)}
    const target=parts.join('/');
    if(/\.md$/i.test(target))a.setAttribute('href','#'+encodeURIComponent(linkRef(target,wt)));
    else{a.removeAttribute('href');a.style.color='var(--muted)';a.title=target}
  });
}

// ---------- navigation ----------
function areaOf(ref){return index&&index.areas.find(a=>a.items.some(i=>i.ref===ref))}
// Items of an area as rows of a tree: children sit under their parent (epic > child > sub-child), drawn
// with box characters. A parent that is not in this area (an ADR's backlog item) becomes a group
// heading; an item without a known parent is a root.
function rowsOf(area){
  const byId=new Map(area.items.filter(i=>i.id).map(i=>[i.id,i]));
  const kids=new Map(),roots=[],groups=new Map(),seen=new Set(),rows=[];
  for(const i of area.items){
    const p=i.parent;
    if(p&&p!==i.id&&byId.has(p)){if(!kids.has(p))kids.set(p,[]);kids.get(p).push(i)}
    else if(p){if(!groups.has(p))groups.set(p,[]);groups.get(p).push(i)}
    else roots.push(i);
  }
  function walk(i,trail,last,depth){
    if(seen.has(i))return;
    seen.add(i);
    rows.push({item:i,prefix:depth?trail.join('')+(last?'└─ ':'├─ '):''});
    const c=kids.get(i.id)||[];
    c.forEach((k,n)=>walk(k,depth?trail.concat(last?'   ':'│  '):[],n===c.length-1,depth+1));
  }
  const list=(items)=>items.forEach(i=>walk(i,[],true,0));
  const everything=all();
  list(roots);
  for(const [p,items] of groups){const owner=everything.find(i=>i.id===p);rows.push({group:p+(owner?' · '+owner.title:'')});list(items)}
  // members of a parent cycle are never reached from a root: still list them
  const left=area.items.filter(i=>!seen.has(i));
  if(left.length){rows.push({group:'Other'});list(left)}
  return rows;
}
function rowHtml(r){
  if(r.group)return '<div class="grp">'+esc(r.group)+'</div>';
  const i=r.item,m=i.file.match(/^(BL-\d+)(.*)$/);
  const name=m?'<b>'+esc(m[1])+'</b>'+esc(m[2]):esc(i.file);
  const w=wtOf(i),badges=flags(i,false);
  const q=[i.file,i.title,i.id,i.status,i.priority,w?w.branch:''].join(' ').toLowerCase();
  return '<div class="row" role="option" tabindex="-1" data-ref="'+esc(i.ref)+'" data-q="'+esc(q)+'"><span class="tree">'+esc(r.prefix)+'</span><span class="name">'+name+(badges?'<span class="flags">'+badges+'</span>':'')+'</span>'+
    (i.mtime?'<span class="when" title="Last written '+fmtAt(i.mtime)+'">'+fmtAt(i.mtime)+'</span>':'')+
    (i.priority?'<span class="prio p-'+esc(i.priority)+'">'+esc(i.priority)+'</span>':'')+
    (i.status?'<span class="st st-'+esc(i.status)+'">'+esc(i.status)+'</span>':'')+'</div>';
}
// One dropdown per area: a button that opens a panel with roomy, larger rows.
function buildPicks(){
  buildWts();
  const wrap=$('#picks');wrap.style.display='contents';
  // with the toggle on, each dropdown keeps only the entries from other worktrees (a parent outside
  // that set becomes a group heading, so the tree still reads)
  const only=onlyWt&&index.worktrees.length>0;
  const areas=index.areas.map(a=>only?{...a,items:a.items.filter(i=>i.wt)}:a).filter(a=>a.items.length);
  wrap.innerHTML=(only&&!areas.length?'<span class="pick">nothing in other worktrees yet</span>':'')+areas.map(a=>'<div class="pick" data-a="'+a.id+'"><span class="lbl">'+esc(a.label)+' ('+a.items.length+')</span>'+
    '<button type="button" class="dd" aria-haspopup="listbox" aria-expanded="false"><span class="ddt">— select —</span><span class="car">▾</span></button>'+
    '<div class="panel" role="listbox" hidden><div class="find"><input type="search" placeholder="Search (id, title, status, P0...)" aria-label="Search '+esc(a.label)+'" autocomplete="off" spellcheck="false"></div>'+
    rowsOf(a).map(rowHtml).join('')+'<div class="nomatch" hidden>No match</div></div></div>').join('');
  wrap.onclick=(e)=>{
    const b=e.target.closest('.dd');if(b){togglePanel(b.closest('.pick'));return}
    const r=e.target.closest('.row');if(r){location.hash=encodeURIComponent(r.dataset.ref);closePanels()}
  };
  wrap.oninput=(e)=>{if(e.target.matches('.find input'))filterPanel(e.target.closest('.pick'),e.target.value)};
  wrap.onkeydown=(e)=>{
    const p=e.target.closest('.pick');if(!p)return;
    const isOpen=p.classList.contains('open');
    if(e.key==='Escape'&&isOpen){togglePanel(p);p.querySelector('.dd').focus();return}
    const rows=[...p.querySelectorAll('.row')].filter(r=>!r.hidden);
    if(e.key==='ArrowDown'||e.key==='ArrowUp'){
      e.preventDefault();if(!isOpen)togglePanel(p);
      const visible=[...p.querySelectorAll('.row')].filter(r=>!r.hidden);
      if(!visible.length)return;
      const idx=visible.indexOf(document.activeElement);
      if(idx<0&&e.target.matches('.find input')&&e.key==='ArrowDown'){visible[0].focus();return}
      if(idx===0&&e.key==='ArrowUp'){p.querySelector('.find input').focus();return}
      const n=idx<0?Math.max(0,visible.findIndex(r=>r.classList.contains('sel'))):idx+(e.key==='ArrowDown'?1:-1);
      visible[Math.min(visible.length-1,Math.max(0,n))].focus();
    }
    if(e.key==='Enter'){
      if(e.target.classList.contains('row'))e.target.click();
      else if(e.target.matches('.find input')&&rows.length){e.preventDefault();rows[0].click()}
    }
  };
  markActive();
}
// Search: every word typed must appear in the row's id, name, title, status or priority; group headings with no
// visible row under them are hidden too.
function filterPanel(p,text){
  const words=text.toLowerCase().split(/\s+/).filter(Boolean);
  const panel=p.querySelector('.panel');
  let group=null,groupHas=false,any=false;
  const closeGroup=()=>{if(group)group.hidden=!groupHas};
  for(const el of panel.children){
    if(el.classList.contains('grp')){closeGroup();group=el;groupHas=false}
    else if(el.classList.contains('row')){
      const show=words.every(w=>el.dataset.q.includes(w));
      el.hidden=!show;if(show){groupHas=true;any=true}
    }
  }
  closeGroup();
  panel.querySelector('.nomatch').hidden=any;
}
function closePanels(except){
  document.querySelectorAll('.pick.open').forEach(p=>{if(p===except)return;p.classList.remove('open');p.querySelector('.panel').hidden=true;p.querySelector('.dd').setAttribute('aria-expanded','false')});
}
function togglePanel(p){
  const open=!p.classList.contains('open');
  closePanels(open?p:null);
  p.classList.toggle('open',open);
  const panel=p.querySelector('.panel');panel.hidden=!open;p.querySelector('.dd').setAttribute('aria-expanded',String(open));
  if(open){
    panel.style.left='0px';const r=panel.getBoundingClientRect();
    if(r.right>innerWidth-8)panel.style.left=(innerWidth-8-r.right)+'px';
    const box=panel.querySelector('.find input');box.value='';filterPanel(p,'');
    // show the active item: scroll it into the middle of the list (after the filter is cleared, so rows do not shift)
    const sel=panel.querySelector('.row.sel');
    if(sel)panel.scrollTop=Math.max(0,sel.offsetTop-panel.clientHeight/2+sel.offsetHeight/2);
    box.focus({preventScroll:true});
  }
}
function markActive(){
  const a=current&&areaOf(current);
  document.querySelectorAll('.pick').forEach(p=>{
    const on=!!a&&p.dataset.a===a.id;p.classList.toggle('active',on);
    p.querySelectorAll('.row').forEach(r=>r.classList.toggle('sel',on&&r.dataset.ref===current));
    const item=on&&a.items.find(i=>i.ref===current);
    p.querySelector('.ddt').textContent=item?item.file:'— select —';
  });
}
async function open(ref,force){
  if(ref===current&&!force)return;
  const {wt,path}=splitRef(ref);
  const r=await fetch('/api/file?path='+encodeURIComponent(path)+(wt?'&wt='+encodeURIComponent(wt):''));
  if(!r.ok){
    // the worktree went away (merged and removed): show the copy the index has now, if any
    const now=wt&&index&&all().find(i=>i.path===path);
    if(now&&now.ref!==ref){location.replace('#'+encodeURIComponent(now.ref));return}
    $('#doc').innerHTML='<p class="empty">Cannot open '+esc(path)+(wt?' in worktree '+esc(wt):'')+' ('+r.status+')</p>';return}
  const text=await r.text();
  const moved=ref!==current;current=ref;
  // badges can change (worktree dirty, status on base) without the text changing
  const sig=text+'\u0000'+(index?flags(itemOf(ref)||{},true)+'\u0000'+((itemOf(ref)||{}).mtime||''):'');
  if(!moved&&sig===currentText)return;
  const y=window.scrollY;currentText=sig;render(text,ref);markActive();
  document.title=path.split('/').pop().replace(/\.md$/i,'')+' · Project docs';
  window.scrollTo(0,moved?0:y);
}
// The hash is a ref, optionally followed by '/<heading anchor>'. A branch name may itself contain
// '.md/' (y.md/z:docs/x.md), so the ref ends at the LAST '.md' that is followed by '/' or the end.
function refOfHash(h){
  const lower=h.toLowerCase();
  for(let k=lower.lastIndexOf('.md');k>=0;k=k?lower.lastIndexOf('.md',k-1):-1){const c=h[k+3];if(c===undefined||c==='/')return h.slice(0,k+3)}
  return '';
}
function route(){
  const ref=refOfHash(decodeURIComponent(location.hash.slice(1)));
  if(ref)open(ref);
}
addEventListener('hashchange',route);
document.addEventListener('click',(e)=>{if(!e.target.closest('.pick'))closePanels()});

async function poll(){
  try{
    const next=await (await fetch('/api/index')).json();
    $('#live').textContent='live · '+new Date().toLocaleTimeString();
    if(!index||next.version!==index.version){
      const first=!index;index=next;buildPicks();
      if(first)route();else if(current)open(current,true);
    }
  }catch(e){$('#live').textContent='server stopped — restart node tools/docs.mjs'}
  // the next poll starts 2s after this one answered, so a slow scan never piles up requests
  setTimeout(poll,2000);
}
poll();
</script></body></html>`;
