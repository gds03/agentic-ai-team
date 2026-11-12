#!/usr/bin/env node
// Backlog board: reads docs/backlog/*.md and shows where every story stands.
//
//   node tools/board.mjs                 text summary + writes .board/index.html
//   node tools/board.mjs --open          ...and opens the page in the browser
//   node tools/board.mjs --watch         keep running: regenerate on every backlog change, page reloads itself
//   node tools/board.mjs --week 2026-10-19   report for the week containing that date
//   node tools/board.mjs --dir <path> --out <file>   other backlog folder / output file
//
// Work in progress in other git worktrees is picked up too: for every worktree of this repo the
// item files that branch changed (committed or not) override the first worktree's copy. Pass
// --dir to read one folder only and skip that.
//
// No dependencies, Node 18+. This is team tooling, not part of the product.

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync, watch } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------- args ----------
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const backlogDir = resolve(opt('--dir') ?? join(root, 'docs', 'backlog'));
const outFile = resolve(opt('--out') ?? join(root, '.board', 'index.html'));
const STALE_DAYS = 3;
const watching = args.includes('--watch');
const versionFile = join(dirname(outFile), 'version.js');

const STATUSES = ['idea', 'designed', 'ready', 'in-progress', 'in-review', 'in-qa', 'done'];
const KINDS = ['EPIC', 'ARCH', 'CODE', 'RESEARCH', 'QA', 'BUG', 'DOCS'];

// ---------- parsing ----------
function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].replace(/\s+#.*$/, '').trim(); // trailing "# comment"
    if (v.startsWith('[') && v.endsWith(']')) {
      v = v.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean);
    }
    fm[kv[1]] = v;
  }
  return { fm, body: m[2] };
}

function sections(body) {
  const out = {};
  let cur = null;
  for (const line of body.split(/\r?\n/)) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) { cur = h[1].toLowerCase(); out[cur] = []; continue; }
    if (cur) out[cur].push(line);
  }
  return out;
}

const stripComments = (lines) => lines.join('\n').replace(/<!--[\s\S]*?-->/g, '').split('\n');

function parseLog(lines) {
  const events = [];
  for (const line of lines) {
    const m = line.match(/^-\s+(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2}):(\d{2}))?\s+([\w-]+):\s*(.*)$/);
    if (!m) continue; // skips the YYYY-MM-DD placeholder in the template
    const [, y, mo, d, h, mi, role, text] = m;
    events.push({
      at: new Date(+y, +mo - 1, +d, h ? +h : 0, mi ? +mi : 0),
      hasTime: Boolean(h),
      role,
      text,
    });
  }
  return events;
}

function loadItems(dir, only) {
  const items = [];
  for (const file of readdirSync(dir).sort()) {
    if (!/^BL-\d{4}.*\.md$/.test(file)) continue; // skips README.md and _template.md
    if (only && !only.has(file)) continue;
    const parsed = parseFrontmatter(readFileSync(join(dir, file), 'utf8'));
    if (!parsed) continue;
    const { fm, body } = parsed;
    const sec = sections(body);
    const criteria = stripComments(sec['acceptance criteria'] ?? []).filter((l) => /^\s*\d+\./.test(l) && l.replace(/^\s*\d+\.\s*/, '').trim());
    const questions = stripComments(sec['open questions'] ?? []).filter((l) => l.trim() && !/answered/i.test(l) && !/^\s*none\b/i.test(l));
    const log = parseLog(sec['log'] ?? []).sort((a, b) => a.at - b.at);
    items.push({
      file,
      id: fm.id || file.match(/^(BL-\d{4})/)[1],
      title: fm.title || file.replace(/\.md$/, ''),
      kind: (fm.kind || file.match(/^BL-\d{4}(?:-BL-\d{4})?-([A-Z]+)-/)?.[1] || '').toUpperCase(),
      type: fm.type || '',
      status: fm.status || 'idea',
      priority: fm.priority || 'P2',
      dependsOn: Array.isArray(fm.depends_on) ? fm.depends_on : [],
      parent: fm.parent || '',
      owner: fm.owner || '',
      blocked: fm.blocked === 'true',
      spec: fm.spec || '',
      pr: fm.pr || '',
      criteria: criteria.length,
      questions: questions.length,
      log,
      lastActivity: log.length ? log[log.length - 1].at : null,
    });
  }
  return items;
}

// ---------- worktrees ----------
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const lines = (s) => s.split(/\r?\n/).filter(Boolean);

function listWorktrees() {
  if (opt('--dir')) return [];
  try {
    return git(root, 'worktree', 'list', '--porcelain').split(/\r?\n\r?\n/).map((block) => {
      const path = block.match(/^worktree (.+)$/m)?.[1];
      if (!path || /^bare$/m.test(block)) return null;
      return { path: resolve(path), branch: block.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? '(detached)', head: block.match(/^HEAD (\w+)$/m)?.[1] };
    }).filter(Boolean);
  } catch {
    return []; // not a git repository
  }
}

// Backlog files a worktree changed relative to the base: committed since the merge base, edited, or new.
function changedFiles(wt, base, rel) {
  let from = null;
  try { from = git(wt.path, 'merge-base', 'HEAD', base.head); } catch { /* unrelated history: take every file */ }
  const names = new Set();
  if (from) {
    for (const f of [...lines(git(wt.path, 'diff', '--name-only', from, '--', rel)), ...lines(git(wt.path, 'ls-files', '--others', '--exclude-standard', '--', rel))]) names.add(f.split('/').pop());
  }
  return from ? names : null;
}

// Items from the base backlog, overridden by what each other worktree is changing.
function loadAll() {
  const wts = listWorktrees();
  const rel = relative(root, backlogDir);
  if (wts.length < 2) return { items: loadItems(backlogDir), wts: [] };
  const [base, ...others] = wts;
  const items = loadItems(join(base.path, rel));
  const byIdMap = new Map(items.map((i) => [i.id, i]));
  const out = [];
  for (const wt of others) {
    const dir = join(wt.path, rel);
    let dirty = false;
    try { dirty = git(wt.path, 'status', '--porcelain') !== ''; } catch { /* worktree gone */ }
    const info = { path: wt.path, branch: wt.branch, dirty, items: [] };
    out.push(info);
    if (!existsSync(dir)) continue;
    let only;
    try { only = changedFiles(wt, base, rel); } catch { only = null; }
    for (const item of loadItems(dir, only ?? undefined)) {
      const main = byIdMap.get(item.id);
      if (main?.worktree) main.conflict = [...(main.conflict ?? []), wt.branch]; // two worktrees on one item
      else {
        item.worktree = info;
        item.mainStatus = main?.status ?? null;
        if (main) items.splice(items.indexOf(main), 1, item);
        else items.push(item);
        byIdMap.set(item.id, item);
        info.items.push(item);
      }
    }
  }
  items.sort((x, y) => x.file.localeCompare(y.file));
  return { items, wts: out };
}

// ---------- analysis ----------
const byId = (items) => new Map(items.map((i) => [i.id, i]));

function analyse(items, weekStart, weekEnd, now) {
  const map = byId(items);
  const unmet = (i) => i.dependsOn.filter((d) => map.get(d)?.status !== 'done');
  const inWeek = (d) => d && d >= weekStart && d < weekEnd;

  const startable = items.filter((i) => i.kind !== 'EPIC' && ['designed', 'ready'].includes(i.status) &&!i.blocked && !unmet(i).length && !i.questions);
  const blocked = items.filter((i) => i.status !== 'done' && (i.blocked || i.questions));
  const waiting = items.filter((i) => i.status !== 'done' && unmet(i).length);
  const stale = items.filter((i) => ['in-progress', 'in-review', 'in-qa'].includes(i.status) && i.lastActivity && (now - i.lastActivity) / 864e5 > STALE_DAYS);
  const doneThisWeek = items.filter((i) => i.status === 'done' && inWeek(i.lastActivity));
  const createdThisWeek = items.filter((i) => inWeek(i.log[0]?.at));
  const events = items.flatMap((i) => i.log.filter((e) => inWeek(e.at)).map((e) => ({ ...e, item: i })))
    .sort((a, b) => b.at - a.at);

  const children = new Map();
  for (const i of items) if (i.parent) children.set(i.parent, [...(children.get(i.parent) ?? []), i]);
  const epicIds = new Set([...children.keys()].filter((id) => map.has(id)));
  for (const i of items) if (i.kind === 'EPIC') epicIds.add(i.id);
  const epics = [...epicIds].sort()
    .map((id) => {
      const kids = (children.get(id) ?? []).slice().sort((x, y) => STATUSES.indexOf(x.status) - STATUSES.indexOf(y.status) || x.id.localeCompare(y.id));
      return { parent: map.get(id), kids, done: kids.filter((k) => k.status === 'done').length };
    });

  // Epic status rule (docs/backlog/README.md, "Epic status"): an epic is in-progress once one child has
  // started and done when every child is done. Report the epics whose status says something else.
  const notStarted = ['idea', 'designed', 'ready'];
  const epicDrift = epics.filter((e) => e.parent?.kind === 'EPIC' && e.kids.length).map((e) => {
    const n = e.kids.length, s = e.parent.status, started = e.kids.filter((k) => !notStarted.includes(k.status)).length;
    if (e.done === n && s !== 'done') return { epic: e.parent, want: 'done', why: `all ${n} children are done` };
    if (e.done < n && s === 'done') return { epic: e.parent, want: started ? 'in-progress' : 'designed', why: `${n - e.done} of ${n} children are not done` };
    if (started && notStarted.includes(s)) return { epic: e.parent, want: 'in-progress', why: `${started} of ${n} children started or done` };
    return null;
  }).filter(Boolean);

  return { map, unmet, startable, blocked, waiting, stale, doneThisWeek, createdThisWeek, events, epics, epicDrift };
}

function weekBounds(dateStr) {
  const base = dateStr ? new Date(...dateStr.split('-').map((n, i) => (i === 1 ? +n - 1 : +n))) : new Date();
  const start = new Date(base.getFullYear(), base.getMonth(), base.getDate() - ((base.getDay() + 6) % 7));
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
  return [start, end];
}

// ---------- formatting ----------
const pad = (n) => String(n).padStart(2, '0');
const fmtDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtStamp = (e) => fmtDate(e.at) + (e.hasTime ? ` ${pad(e.at.getHours())}:${pad(e.at.getMinutes())}` : '');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ago = (d, now) => {
  if (!d) return 'no activity';
  const days = Math.floor((now - d) / 864e5);
  return days <= 0 ? 'today' : days === 1 ? '1 day ago' : `${days} days ago`;
};

// ---------- text report ----------
function textReport(items, a, weekStart, weekEnd, now) {
  const L = [];
  const last = new Date(weekEnd.getFullYear(), weekEnd.getMonth(), weekEnd.getDate() - 1);
  const done = items.filter((i) => i.status === 'done').length;
  L.push(`Backlog week ${fmtDate(weekStart)} .. ${fmtDate(last)}   (${done}/${items.length} done)`, '');
  L.push(STATUSES.map((s) => `${s}: ${items.filter((i) => i.status === s).length}`).join('   '), '');
  const list = (title, arr, extra = () => '') => {
    L.push(`${title} (${arr.length})`);
    if (!arr.length) L.push('  -');
    for (const i of arr) L.push(`  ${i.id} ${i.kind.padEnd(8)} ${i.title}${extra(i)}`);
    L.push('');
  };
  list('Done this week', a.doneThisWeek);
  list('Created this week', a.createdThisWeek);
  list('Can start now', a.startable, (i) => `  [${i.priority}]`);
  list('Blocked on the product owner', a.blocked, (i) => (i.questions ? `  (${i.questions} open question${i.questions > 1 ? 's' : ''})` : ''));
  list('Waiting on dependencies', a.waiting, (i) => `  (needs ${a.unmet(i).join(', ')})`);
  list(`Stale (> ${STALE_DAYS} days, in progress/review/QA)`, a.stale, (i) => `  (${i.status}, ${ago(i.lastActivity, now)})`);
  list('Epics out of sync with their children', a.epicDrift.map((d) => d.epic), (i) => { const d = a.epicDrift.find((x) => x.epic === i); return `  is ${i.status}, should be ${d.want} (${d.why})`; });
  return L.join('\n');
}

// ---------- html ----------
const drift = (i) => !i.worktree ? '' : i.mainStatus === null ? 'new on branch' : i.mainStatus !== i.status ? `${i.status} on branch, ${i.mainStatus} on main` : '';

function card(i, a, now) {
  const unmet = a.unmet(i);
  const flags = [
    (i.blocked || i.questions) && i.status !== 'done' ? `<span class="flag bad">blocked${i.questions ? ` · ${i.questions} question${i.questions > 1 ? 's' : ''}` : ''}</span>` : '',
    unmet.length ? `<span class="flag warn">needs ${esc(unmet.join(', '))}</span>` : '',
    a.stale.includes(i) ? `<span class="flag warn">stale · ${esc(ago(i.lastActivity, now))}</span>` : '',
    i.worktree ? `<span class="flag wt" title="${esc(i.worktree.path)}">⎇ ${esc(i.worktree.branch)}${i.worktree.dirty ? ' · ● uncommitted' : ''}</span>` : '',
    drift(i) ? `<span class="flag warn">${esc(drift(i))}</span>` : '',
    i.conflict ? `<span class="flag bad">also in ${esc(i.conflict.join(', '))}</span>` : '',
  ].join('');
  return `<article class="card" data-kind="${esc(i.kind)}" data-priority="${esc(i.priority)}">
  <div class="row"><span class="id">${esc(i.id)}</span><span class="kind k-${esc(i.kind)}">${esc(i.kind || '?')}</span><span class="prio p-${esc(i.priority)}">${esc(i.priority)}</span></div>
  <div class="title" title="${esc(i.title)}">${esc(i.title)}</div>
  <div class="meta">${i.owner ? `owner: ${esc(i.owner)}` : ''}${i.parent ? ` · parent ${esc(i.parent)}` : ''}${i.criteria ? ` · ${i.criteria} criteria` : ''}${i.pr ? ` · <a href="${esc(i.pr)}">PR</a>` : ''}</div>
  ${flags ? `<div class="flags">${flags}</div>` : ''}
</article>`;
}

function wtPanel(wts) {
  if (!wts.length) return '<p class="none">no other worktrees</p>';
  return wts.map((w) => `<div class="wt"><b>⎇ ${esc(w.branch)}</b>${w.dirty ? ' <span class="flag warn">● uncommitted</span>' : ''}<div class="meta">${esc(w.path)}</div>${
    w.items.length
      ? `<ul>${w.items.map((i) => `<li><span class="id">${esc(i.id)}</span> ${esc(i.title)} <span class="meta">(${esc(i.status)}${i.log.length ? ` · ${esc(i.log[i.log.length - 1].role)}: ${esc(i.log[i.log.length - 1].text.slice(0, 90))}` : ''})</span></li>`).join('')}</ul>`
      : '<div class="meta">no backlog changes yet</div>'}</div>`).join('');
}

// Epic-level dependency graph: an edge A -> B means A (or one of its items) needs B (or one of its items) done first.
function epicGraph(a) {
  const epicIds = new Set(a.epics.map((e) => e.parent?.id).filter(Boolean));
  const owner = (id) => {
    for (let cur = a.map.get(id), hops = 0; cur && hops < 10; cur = a.map.get(cur.parent), hops++) if (epicIds.has(cur.id)) return cur.id;
    return id;
  };
  const deps = new Map(); // node id -> Set of node ids it needs
  const add = (id) => { if (!deps.has(id)) deps.set(id, new Set()); };
  for (const e of a.epics) {
    if (!e.parent) continue;
    const me = e.parent.id;
    add(me);
    for (const src of [e.parent, ...e.kids]) {
      for (const d of src.dependsOn) {
        const to = owner(d);
        if (to === me || !a.map.has(d)) continue;
        add(to);
        deps.get(me).add(to);
      }
    }
  }
  const level = new Map();
  const lv = (id, seen = new Set()) => {
    if (level.has(id)) return level.get(id);
    if (seen.has(id)) return 0; // cycle guard
    seen.add(id);
    const v = [...deps.get(id)].reduce((m, d) => Math.max(m, lv(d, seen) + 1), 0);
    level.set(id, v);
    return v;
  };
  for (const id of deps.keys()) lv(id);
  // drop A -> C when A already reaches C through another prerequisite
  const reaches = (from, target, skip, seen = new Set()) => [...(deps.get(from) ?? [])].some((d) => d !== skip && !seen.has(d) && (d === target || (seen.add(d), reaches(d, target, null, seen))));
  for (const [id, tos] of deps) for (const to of [...tos]) if (reaches(id, to, to)) tos.delete(to);
  return { deps, level, epicIds };
}

function epicGraphSvg(a) {
  const { deps, level, epicIds } = epicGraph(a);
  if (!deps.size) return '<p class="none">no dependencies between epics yet</p>';
  const W = 200, H = 54, GX = 80, GY = 16, PAD = 10;
  const cols = [];
  for (const id of [...deps.keys()].sort()) (cols[level.get(id)] ??= []).push(id);
  const pos = new Map();
  let row = 0; // one row per node, so a line entering a node never crosses another one
  cols.forEach((col, x) => col?.forEach((id) => pos.set(id, { x: PAD + x * (W + GX), y: PAD + 18 + row++ * (H + GY), row })));
  const width = PAD * 2 + cols.length * (W + GX) - GX;
  const height = PAD * 2 + 18 + row * (H + GY) - GY;
  const clip = (t, n) => (t.length > n ? t.slice(0, n - 1) + '…' : t);
  const lines = [...deps].flatMap(([from, tos]) => [...tos].map((to) => {
    const f = pos.get(to), t = pos.get(from); // arrow runs from the prerequisite to the item that needs it
    const x1 = f.x + W, y1 = f.y + H / 2, x2 = t.x, y2 = t.y + H / 2, cx = x1 + 10 + (f.row % 6) * 7;
    return { from, to, x1, y1, x2, y2, cx };
  }));
  // a horizontal run that crosses another arrow's vertical run hops over it with a small arc
  const R = 4;
  const hop = (y, xa, xb, self) => {
    const xs = lines.filter((l) => l !== self && l.cx > xa + R && l.cx < xb - R && y > Math.min(l.y1, l.y2) && y < Math.max(l.y1, l.y2)).map((l) => l.cx).sort((m, n) => m - n);
    return [...new Set(xs)].map((x) => `H${x - R} a${R},${R} 0 0 1 ${2 * R},0`).join(' ') + ` H${xb}`;
  };
  const edges = lines.map((l) => {
    const open = a.map.get(l.to)?.status !== 'done';
    return `<path class="edge${open ? ' open' : ''}" d="M${l.x1},${l.y1} ${hop(l.y1, l.x1, l.cx, l)} V${l.y2} ${hop(l.y2, l.cx, l.x2, l)}" marker-end="url(#arr)"><title>${esc(l.from)} needs ${esc(l.to)}</title></path>`;
  }).join('');
  const nodes = [...pos].map(([id, p]) => {
    const it = a.map.get(id);
    const isEpic = epicIds.has(id);
    const e = a.epics.find((x) => x.parent?.id === id);
    const prog = e && e.kids.length ? ` · ${e.done}/${e.kids.length}` : '';
    return `<g class="gnode s-${esc(it?.status ?? '')}${isEpic ? ' epic' : ''}" transform="translate(${p.x},${p.y})"><title>${esc(id)} ${esc(it?.title ?? '')} (${esc(it?.status ?? '?')})</title><rect width="${W}" height="${H}" rx="6"/><text class="gid" x="8" y="17">${esc(id)}${isEpic ? ' · EPIC' : ''}</text><text class="gst" x="${W - 8}" y="17" text-anchor="end">${esc(it?.status ?? '')}${esc(prog)}</text><text class="gtitle" x="8" y="38">${esc(clip(it?.title ?? '', 30))}</text></g>`;
  }).join('');
  const heads = cols.map((c, x) => (c ? `<text class="gwave" x="${PAD + x * (W + GX)}" y="${PAD + 6}">${x === 0 ? 'start here' : `then (wave ${x + 1})`}</text>` : '')).join('');
  return `<div class="graph"><svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Epic dependency graph"><defs><marker id="arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" class="head"/></marker></defs>${heads}${edges}${nodes}</svg></div><p class="meta">Arrows point from a prerequisite to what needs it. Orange arrows are still waiting on an unfinished prerequisite. Left to right is a safe delivery order. Redundant arrows (already implied by another path) are left out.</p>`;
}

function html(items, a, weekStart, weekEnd, now, version, wts) {
  const last = new Date(weekEnd.getFullYear(), weekEnd.getMonth(), weekEnd.getDate() - 1);
  const done = items.filter((i) => i.status === 'done').length;
  const pct = items.length ? Math.round((done / items.length) * 100) : 0;
  const mini = (arr, extra = () => '') => arr.length
    ? `<ul class="pg" data-size="6">${arr.map((i) => `<li><span class="id">${esc(i.id)}</span> <span class="kind k-${esc(i.kind)}">${esc(i.kind)}</span> ${esc(i.title)}${extra(i)}</li>`).join('')}</ul>`
    : '<p class="none">none</p>';

  const sorted = (st) => items.filter((i) => i.status === st).sort((x, y) => x.priority.localeCompare(y.priority) || x.id.localeCompare(y.id));
  const columns = STATUSES.map((st) => {
    const col = sorted(st);
    return `<section class="col"><header><h3>${st} <span class="count">${col.length}</span></h3><div class="pager"></div></header><div class="cards pg" data-size="8">${col.map((i) => card(i, a, now)).join('') || '<p class="none">empty</p>'}</div></section>`;
  }).join('');

  const epics = a.epics.length
    ? a.epics.map((e) => {
        const n = e.kids.length;
        const p = n ? Math.round((e.done / n) * 100) : 0;
        const epicNeeds = a.unmet(e.parent);
        const kids = e.kids.map((k) => {
          const needs = a.unmet(k);
          const flag = (k.blocked || k.questions) && k.status !== 'done' ? '<span class="flag bad">blocked</span>' : '';
          return `<div class="kid s-${esc(k.status)}" title="${esc(k.title)}"><div class="row"><span class="id">${esc(k.id)}</span><span class="kind k-${esc(k.kind)}">${esc(k.kind)}</span><span class="prio p-${esc(k.priority)}">${esc(k.priority)}</span><span class="st">${esc(k.status)}</span></div><div class="title">${esc(k.title)}</div>${needs.length || flag ? `<div class="flags">${flag}${needs.length ? `<span class="flag warn">needs ${esc(needs.join(', '))}</span>` : ''}</div>` : ''}</div>`;
        }).join('') || '<p class="none">no child items yet</p>';
        return `<article class="epiccard"><div class="row"><span class="id">${esc(e.parent.id)}</span><span class="kind k-EPIC">EPIC</span><span class="st">${esc(e.parent.status)}</span>${(() => { const d = a.epicDrift.find((x) => x.epic === e.parent); return d ? `<span class="flag bad" title="${esc(d.why)}">should be ${esc(d.want)}</span>` : ''; })()}<span class="meta" style="margin-left:auto">${e.done}/${n} done</span></div><div class="title wrap">${esc(e.parent.title)}</div><div class="bar"><i style="width:${p}%"></i></div>${epicNeeds.length ? `<div class="flags"><span class="flag warn">epic needs ${esc(epicNeeds.join(', '))}</span></div>` : ''}<div class="kids">${kids}</div></article>`;
      }).join('')
    : '<p class="none">no epics yet</p>';

  const feed = a.events.length
    ? `<ul class="feed pg" data-size="10">${a.events.map((e) => `<li title="${esc(`${e.item.id} ${e.role}: ${e.text}`)}"><time>${esc(fmtStamp(e))}</time> <span class="id">${esc(e.item.id)}</span> <b>${esc(e.role)}</b> ${esc(e.text)}</li>`).join('')}</ul>`
    : '<p class="none">no activity logged this week</p>';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Backlog board</title>
<style>
:root{--bg:#f6f7f9;--panel:#fff;--text:#1b1f24;--muted:#667085;--line:#e3e6eb;--accent:#3b6fe0;--bad:#c4382f;--warn:#a96a00;--ok:#237a4b}
@media (prefers-color-scheme:dark){:root{--bg:#14171c;--panel:#1c2027;--text:#e6e9ee;--muted:#98a2b3;--line:#2a303a;--accent:#7a9cf5;--bad:#f0706a;--warn:#e0a63c;--ok:#5cc08a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,Segoe UI,sans-serif}
main{max-width:1500px;margin:0 auto;padding:20px 16px 48px}
h1{font-size:20px;margin:0}h2{font-size:15px;margin:0 0 8px}h3{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 8px}
.sub{color:var(--muted);margin:2px 0 16px}
.stats{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:16px}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:10px 14px;min-width:110px}
.stat b{display:block;font-size:22px}.stat span{color:var(--muted);font-size:12px}
.bar{height:8px;background:var(--line);border-radius:4px;overflow:hidden}.bar i{display:block;height:100%;background:var(--ok)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px;margin-bottom:20px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px 14px}
.panel ul{margin:0;padding-left:18px}.panel li{margin:3px 0}
.none{color:var(--muted);margin:0;font-style:italic}
.board{display:grid;grid-template-columns:repeat(7,minmax(165px,1fr));gap:8px;overflow-x:auto;padding-bottom:8px;align-items:start}
.col{background:color-mix(in srgb,var(--panel) 55%,var(--bg));border:1px solid var(--line);border-radius:8px;padding:8px;min-width:0}
.col header{display:flex;align-items:center;justify-content:space-between;gap:4px;margin-bottom:8px}.col h3{margin:0}
.cards{display:flex;flex-direction:column;gap:6px}
.pager{display:inline-flex;align-items:center;gap:4px;color:var(--muted);font-size:11px;white-space:nowrap}
.pager button{background:none;color:var(--text);border:1px solid var(--line);border-radius:4px;width:20px;height:20px;line-height:1;padding:0;cursor:pointer}.pager button:disabled{opacity:.35;cursor:default}
ul + .pager{display:flex;justify-content:flex-end;margin-top:6px}
.panel ul.pg{list-style:none;padding-left:0}.panel li{overflow-wrap:anywhere}
.count{background:var(--line);border-radius:10px;padding:0 7px;margin-left:4px;color:var(--text)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:4px 8px;min-width:0}.card[hidden],.pager[hidden]{display:none}
.row{display:flex;gap:6px;align-items:center}.id{font-family:ui-monospace,Consolas,monospace;font-size:12px;color:var(--muted)}
.title{margin:1px 0;font-weight:600;font-size:12.5px;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.meta{color:var(--muted);font-size:12px}.card .meta{font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.kind,.prio{font-size:10px;font-weight:700;border-radius:4px;padding:1px 5px;border:1px solid var(--line)}
.prio{margin-left:auto}.p-P0{color:var(--bad);border-color:var(--bad)}.p-P1{color:var(--warn);border-color:var(--warn)}
.k-EPIC{color:#8e5bd6}.k-ARCH{color:#2f8f9d}.k-CODE{color:var(--accent)}.k-RESEARCH{color:#b8741a}.k-QA{color:var(--ok)}.k-BUG{color:var(--bad)}.k-DOCS{color:var(--muted)}
.flags{margin-top:2px;display:flex;flex-wrap:wrap;gap:3px}.flag{font-size:10px;border-radius:4px;padding:0 5px;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.flag.bad{background:color-mix(in srgb,var(--bad) 15%,transparent);color:var(--bad)}.flag.warn{background:color-mix(in srgb,var(--warn) 15%,transparent);color:var(--warn)}
.flag.wt{background:color-mix(in srgb,var(--accent) 15%,transparent);color:var(--accent)}.wt{margin-bottom:10px}.wt ul{margin-top:4px}
.epics{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px;margin-bottom:20px;align-items:start}
.epiccard{background:var(--panel);border:1px solid var(--line);border-top:3px solid #8e5bd6;border-radius:8px;padding:10px 12px}.epiccard .bar{margin:6px 0}
.title.wrap{white-space:normal;font-size:14px}.kids{display:flex;flex-direction:column;gap:5px;margin-top:8px;max-height:340px;overflow-y:auto}
.kid{border:1px solid var(--line);border-left:3px solid var(--muted);border-radius:5px;padding:3px 8px;background:color-mix(in srgb,var(--panel) 55%,var(--bg))}
.kid.s-done{border-left-color:var(--ok);opacity:.75}.kid.s-in-progress,.kid.s-in-review,.kid.s-in-qa{border-left-color:var(--accent)}.kid.s-ready,.kid.s-designed{border-left-color:var(--warn)}
.st{font-size:10px;color:var(--muted);margin-left:auto}.epiccard>.row .st{margin-left:0}.kid>.row .st{margin-left:0}
.gd{border:2px solid #8e5bd6;border-radius:8px;padding:8px 12px;margin-bottom:20px;background:color-mix(in srgb,#8e5bd6 6%,transparent)}.gd>summary{cursor:pointer;list-style:revert}.gd>summary h2{display:inline;margin:0}.gd[open]>summary{margin-bottom:8px}.graph{max-height:70vh;overflow:auto;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:6px;margin-bottom:6px}.graph svg{display:block}
.edge{fill:none;stroke:var(--muted);stroke-width:1.5;stroke-linejoin:round}.edge.open{stroke:var(--warn)}.head{fill:var(--muted)}
.gnode rect{fill:color-mix(in srgb,var(--panel) 55%,var(--bg));stroke:var(--muted);stroke-width:1.5}.gnode.epic rect{stroke:#8e5bd6}.gnode.s-done rect{stroke:var(--ok);opacity:.8}
.gnode.s-in-progress rect,.gnode.s-in-review rect,.gnode.s-in-qa rect{stroke:var(--accent)}.gnode.s-ready rect,.gnode.s-designed rect{stroke:var(--warn)}
.gnode text{fill:var(--text)}.gid{font:11px ui-monospace,Consolas,monospace;fill:var(--muted)!important}.gst{font-size:10px;fill:var(--muted)!important}.gtitle{font-size:12px;font-weight:600}.gwave{font-size:11px;fill:var(--muted)!important}
.feed{list-style:none;padding:0!important}.feed li{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.feed time{color:var(--muted);font-family:ui-monospace,Consolas,monospace;font-size:12px}
.filters{margin:0 0 10px;display:flex;gap:6px;flex-wrap:wrap}.filters button{background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:14px;padding:3px 11px;cursor:pointer}
.filters button[aria-pressed=true]{background:var(--accent);color:#fff;border-color:var(--accent)}
a{color:var(--accent)}
</style></head><body><main>
<h1>Backlog board${watching ? ' <span class="meta">· live</span>' : ''}</h1>
<p class="sub">Week ${esc(fmtDate(weekStart))} to ${esc(fmtDate(last))} · generated ${esc(fmtDate(now))} ${pad(now.getHours())}:${pad(now.getMinutes())} from <code>${esc(backlogDir.replace(root, '.'))}</code></p>

<div class="stats">
  <div class="stat"><b>${done}/${items.length}</b><span>done overall (${pct}%)</span><div class="bar"><i style="width:${pct}%"></i></div></div>
  <div class="stat"><b>${a.doneThisWeek.length}</b><span>done this week</span></div>
  <div class="stat"><b>${a.createdThisWeek.length}</b><span>created this week</span></div>
  <div class="stat"><b>${items.filter((i) => ['in-progress', 'in-review', 'in-qa'].includes(i.status)).length}</b><span>in flight</span></div>
  <div class="stat"><b>${a.startable.length}</b><span>can start now</span></div>
  <div class="stat"><b style="color:var(--bad)">${a.blocked.length}</b><span>blocked on you</span></div>
  <div class="stat"><b style="color:var(--warn)">${a.stale.length}</b><span>stale (&gt;${STALE_DAYS}d)</span></div>
</div>

<div class="grid">
  <section class="panel"><h2>In flight by worktree</h2>${wtPanel(wts)}</section>
  <section class="panel"><h2>Needs the product owner</h2>${mini(a.blocked, (i) => (i.questions ? ` <span class="meta">(${i.questions} open question${i.questions > 1 ? 's' : ''})</span>` : ''))}</section>
  <section class="panel"><h2>Can start now</h2>${mini(a.startable)}</section>
  <section class="panel"><h2>Waiting on dependencies</h2>${mini(a.waiting, (i) => ` <span class="meta">(needs ${esc(a.unmet(i).join(', '))})</span>`)}</section>
  <section class="panel"><h2>Done this week</h2>${mini(a.doneThisWeek)}</section>
  <section class="panel"><h2>Activity this week</h2>${feed}</section>
</div>

<h2>Epics</h2>
<div class="epics">${epics}</div>

<details class="gd"><summary><h2>Epic delivery order</h2></summary>
${epicGraphSvg(a)}
</details>

<h2>Board</h2>
<div class="filters" id="filters"><button data-k="" aria-pressed="true">All</button>${KINDS.map((k) => `<button data-k="${k}" aria-pressed="false">${k}</button>`).join('')}</div>
<div class="board">${columns}</div>
<script>
const kinds=[...document.querySelectorAll('#filters button')];
let kind='';
function paginate(box){
  const size=+box.dataset.size||10;const key='board.page.'+[...document.querySelectorAll('.pg')].indexOf(box);let page=0;try{page=+sessionStorage.getItem(key)||0}catch(e){}
  const all=[...box.children].filter(c=>c.tagName!=='P');
  let bar=box.parentElement.querySelector(':scope > header .pager');
  if(!bar){bar=document.createElement('div');bar.className='pager';box.after(bar)}
  box.render=()=>{
    const vis=all.filter(c=>!kind||!c.dataset.kind||c.dataset.kind===kind);
    const pages=Math.max(1,Math.ceil(vis.length/size));page=Math.min(page,pages-1);
    all.forEach(c=>c.hidden=true);
    vis.slice(page*size,page*size+size).forEach(c=>c.hidden=false);
    bar.hidden=pages<2;
    bar.innerHTML='<button aria-label="Previous page" '+(page?'':'disabled')+' data-d="-1">&lsaquo;</button><span>'+(page+1)+'/'+pages+'</span><button aria-label="Next page" '+(page<pages-1?'':'disabled')+' data-d="1">&rsaquo;</button>';
    try{sessionStorage.setItem(key,page)}catch(e){}
    bar.querySelectorAll('button').forEach(b=>b.onclick=()=>{page+=+b.dataset.d;box.render()});
  };
  box.render();
}
document.querySelectorAll('.pg').forEach(paginate);
try{kind=sessionStorage.getItem('board.kind')||'';kinds.forEach(x=>x.setAttribute('aria-pressed',x.dataset.k===kind));document.querySelectorAll('.col .cards').forEach(c=>c.render())}catch(e){}
kinds.forEach(b=>b.onclick=()=>{kind=b.dataset.k;try{sessionStorage.setItem('board.kind',kind)}catch(e){}kinds.forEach(x=>x.setAttribute('aria-pressed',x===b));
  document.querySelectorAll('.col .cards').forEach(c=>c.render())});
${watching ? `const mine=${JSON.stringify(version)};
setInterval(()=>{const t=document.createElement('script');t.src='version.js?'+Date.now();
t.onload=()=>{t.remove();if(window.__boardVersion&&window.__boardVersion!==mine)location.reload()};t.onerror=()=>t.remove();document.head.appendChild(t)},2000);` : ''}
</script>
</main></body></html>`;
}

// ---------- main ----------
if (!existsSync(backlogDir)) {
  console.error(`Backlog folder not found: ${backlogDir}`);
  process.exit(1);
}

function build({ quiet = false } = {}) {
  const now = new Date();
  const [weekStart, weekEnd] = weekBounds(opt('--week'));
  const { items, wts } = loadAll();
  const analysis = analyse(items, weekStart, weekEnd, now);
  const version = String(now.getTime());

  if (!items.length) {
    console.log('No backlog items yet (expected docs/backlog/BL-NNNN-*.md). Run /groom to create some.');
  }
  if (!quiet) console.log(textReport(items, analysis, weekStart, weekEnd, now));

  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, html(items, analysis, weekStart, weekEnd, now, version, wts));
  if (watching) writeFileSync(versionFile, `window.__boardVersion=${JSON.stringify(version)};
`);
  console.log(`${quiet ? `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())} ` : ''}Board written to ${outFile}`);
}

build();

if (args.includes('--open')) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', outFile]] : process.platform === 'darwin' ? ['open', [outFile]] : ['xdg-open', [outFile]];
  spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref();
}

if (watching) {
  let timer;
  const rebuild = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { try { build({ quiet: true }); } catch (e) { console.error(`rebuild failed: ${e.message}`); } }, 300);
  };
  const rel = relative(root, backlogDir);
  const watchers = new Map();
  // Worktrees come and go and their commits/dirty state change without touching the backlog folder,
  // so re-scan them every few seconds and rebuild when the picture changed.
  const signature = () => JSON.stringify(listWorktrees().map((w) => [w.path, w.branch, w.head, (() => { try { return git(w.path, 'status', '--porcelain'); } catch { return ''; } })()]));
  const syncWatchers = () => {
    const dirs = new Set(listWorktrees().map((w) => join(w.path, rel)).filter(existsSync));
    if (!dirs.size) dirs.add(backlogDir);
    for (const [d, w] of watchers) if (!dirs.has(d)) { w.close(); watchers.delete(d); }
    for (const d of dirs) if (!watchers.has(d)) watchers.set(d, watch(d, rebuild));
  };
  syncWatchers();
  let last = signature();
  setInterval(() => {
    const now = signature();
    if (now === last) return;
    last = now;
    syncWatchers();
    rebuild();
  }, 5000);
  console.log(`Watching ${[...watchers.keys()].join(', ')} (Ctrl+C to stop)`);
}
