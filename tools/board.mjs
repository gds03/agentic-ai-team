#!/usr/bin/env node
// Backlog board: reads docs/backlog/*.md and shows where every story stands.
//
//   node tools/board.mjs                 text summary + writes .board/index.html
//   node tools/board.mjs --open          ...and opens the page in the browser
//   node tools/board.mjs --week 2026-10-19   report for the week containing that date
//   node tools/board.mjs --dir <path> --out <file>   other backlog folder / output file
//
// No dependencies, Node 18+. This is team tooling, not part of the product.

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

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

function loadItems(dir) {
  const items = [];
  for (const file of readdirSync(dir).sort()) {
    if (!/^BL-\d{4}.*\.md$/.test(file)) continue; // skips README.md and _template.md
    const parsed = parseFrontmatter(readFileSync(join(dir, file), 'utf8'));
    if (!parsed) continue;
    const { fm, body } = parsed;
    const sec = sections(body);
    const criteria = stripComments(sec['acceptance criteria'] ?? []).filter((l) => /^\s*\d+\./.test(l) && l.replace(/^\s*\d+\.\s*/, '').trim());
    const questions = stripComments(sec['open questions'] ?? []).filter((l) => l.trim() && !/answered/i.test(l));
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
  const epics = [...children.entries()]
    .filter(([id]) => map.has(id))
    .map(([id, kids]) => ({ parent: map.get(id), kids, done: kids.filter((k) => k.status === 'done').length }));

  return { map, unmet, startable, blocked, waiting, stale, doneThisWeek, createdThisWeek, events, epics };
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
  return L.join('\n');
}

// ---------- html ----------
function card(i, a, now) {
  const unmet = a.unmet(i);
  const flags = [
    i.blocked || i.questions ? `<span class="flag bad">blocked${i.questions ? ` · ${i.questions} question${i.questions > 1 ? 's' : ''}` : ''}</span>` : '',
    unmet.length ? `<span class="flag warn">needs ${esc(unmet.join(', '))}</span>` : '',
    a.stale.includes(i) ? `<span class="flag warn">stale · ${esc(ago(i.lastActivity, now))}</span>` : '',
  ].join('');
  return `<article class="card" data-kind="${esc(i.kind)}" data-priority="${esc(i.priority)}">
  <div class="row"><span class="id">${esc(i.id)}</span><span class="kind k-${esc(i.kind)}">${esc(i.kind || '?')}</span><span class="prio p-${esc(i.priority)}">${esc(i.priority)}</span></div>
  <div class="title">${esc(i.title)}</div>
  <div class="meta">${i.owner ? `owner: ${esc(i.owner)}` : ''}${i.parent ? ` · parent ${esc(i.parent)}` : ''}${i.criteria ? ` · ${i.criteria} criteria` : ''}${i.pr ? ` · <a href="${esc(i.pr)}">PR</a>` : ''}</div>
  ${flags ? `<div class="flags">${flags}</div>` : ''}
</article>`;
}

function html(items, a, weekStart, weekEnd, now) {
  const last = new Date(weekEnd.getFullYear(), weekEnd.getMonth(), weekEnd.getDate() - 1);
  const done = items.filter((i) => i.status === 'done').length;
  const pct = items.length ? Math.round((done / items.length) * 100) : 0;
  const mini = (arr, extra = () => '') => arr.length
    ? `<ul>${arr.map((i) => `<li><span class="id">${esc(i.id)}</span> <span class="kind k-${esc(i.kind)}">${esc(i.kind)}</span> ${esc(i.title)}${extra(i)}</li>`).join('')}</ul>`
    : '<p class="none">none</p>';

  const columns = STATUSES.map((s) => {
    const col = items.filter((i) => i.status === s).sort((x, y) => x.priority.localeCompare(y.priority) || x.id.localeCompare(y.id));
    return `<section class="col"><h3>${s} <span class="count">${col.length}</span></h3>${col.map((i) => card(i, a, now)).join('') || '<p class="none">empty</p>'}</section>`;
  }).join('');

  const epics = a.epics.length
    ? a.epics.map((e) => {
        const p = Math.round((e.done / e.kids.length) * 100);
        return `<div class="epic"><div><span class="id">${esc(e.parent.id)}</span> ${esc(e.parent.title)} <span class="meta">${e.done}/${e.kids.length} done</span></div><div class="bar"><i style="width:${p}%"></i></div></div>`;
      }).join('')
    : '<p class="none">no parent/child items yet</p>';

  const feed = a.events.length
    ? `<ul class="feed">${a.events.map((e) => `<li><time>${esc(fmtStamp(e))}</time> <span class="id">${esc(e.item.id)}</span> <b>${esc(e.role)}</b> ${esc(e.text)}</li>`).join('')}</ul>`
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
.board{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(230px,1fr);gap:10px;overflow-x:auto;padding-bottom:8px}
.col{background:color-mix(in srgb,var(--panel) 55%,var(--bg));border:1px solid var(--line);border-radius:8px;padding:10px;min-height:120px}
.count{background:var(--line);border-radius:10px;padding:0 7px;margin-left:4px;color:var(--text)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:8px 10px;margin-bottom:8px}
.row{display:flex;gap:6px;align-items:center}.id{font-family:ui-monospace,Consolas,monospace;font-size:12px;color:var(--muted)}
.title{margin:4px 0;font-weight:600}.meta{color:var(--muted);font-size:12px}
.kind,.prio{font-size:10px;font-weight:700;border-radius:4px;padding:1px 5px;border:1px solid var(--line)}
.prio{margin-left:auto}.p-P0{color:var(--bad);border-color:var(--bad)}.p-P1{color:var(--warn);border-color:var(--warn)}
.k-EPIC{color:#8e5bd6}.k-ARCH{color:#2f8f9d}.k-CODE{color:var(--accent)}.k-RESEARCH{color:#b8741a}.k-QA{color:var(--ok)}.k-BUG{color:var(--bad)}.k-DOCS{color:var(--muted)}
.flags{margin-top:6px;display:flex;flex-wrap:wrap;gap:4px}.flag{font-size:11px;border-radius:4px;padding:1px 6px}
.flag.bad{background:color-mix(in srgb,var(--bad) 15%,transparent);color:var(--bad)}.flag.warn{background:color-mix(in srgb,var(--warn) 15%,transparent);color:var(--warn)}
.epic{margin-bottom:10px}.epic .bar{margin-top:4px}
.feed{list-style:none;padding:0!important}.feed time{color:var(--muted);font-family:ui-monospace,Consolas,monospace;font-size:12px}
.filters{margin:0 0 10px;display:flex;gap:6px;flex-wrap:wrap}.filters button{background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:14px;padding:3px 11px;cursor:pointer}
.filters button[aria-pressed=true]{background:var(--accent);color:#fff;border-color:var(--accent)}
a{color:var(--accent)}
</style></head><body><main>
<h1>Backlog board</h1>
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
  <section class="panel"><h2>Needs the product owner</h2>${mini(a.blocked, (i) => (i.questions ? ` <span class="meta">(${i.questions} open question${i.questions > 1 ? 's' : ''})</span>` : ''))}</section>
  <section class="panel"><h2>Can start now</h2>${mini(a.startable)}</section>
  <section class="panel"><h2>Waiting on dependencies</h2>${mini(a.waiting, (i) => ` <span class="meta">(needs ${esc(a.unmet(i).join(', '))})</span>`)}</section>
  <section class="panel"><h2>Done this week</h2>${mini(a.doneThisWeek)}</section>
  <section class="panel"><h2>Epic progress</h2>${epics}</section>
  <section class="panel"><h2>Activity this week</h2>${feed}</section>
</div>

<h2>Board</h2>
<div class="filters" id="filters"><button data-k="" aria-pressed="true">All</button>${KINDS.map((k) => `<button data-k="${k}" aria-pressed="false">${k}</button>`).join('')}</div>
<div class="board">${columns}</div>
<script>
const btns=[...document.querySelectorAll('#filters button')];
btns.forEach(b=>b.onclick=()=>{btns.forEach(x=>x.setAttribute('aria-pressed',x===b));
document.querySelectorAll('.card').forEach(c=>c.hidden=b.dataset.k&&c.dataset.kind!==b.dataset.k)});
</script>
</main></body></html>`;
}

// ---------- main ----------
if (!existsSync(backlogDir)) {
  console.error(`Backlog folder not found: ${backlogDir}`);
  process.exit(1);
}
const now = new Date();
const [weekStart, weekEnd] = weekBounds(opt('--week'));
const items = loadItems(backlogDir);
const analysis = analyse(items, weekStart, weekEnd, now);

if (!items.length) {
  console.log('No backlog items yet (expected docs/backlog/BL-NNNN-*.md). Run /groom to create some.');
}
console.log(textReport(items, analysis, weekStart, weekEnd, now));

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, html(items, analysis, weekStart, weekEnd, now));
console.log(`Board written to ${outFile}`);

if (args.includes('--open')) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', outFile]] : process.platform === 'darwin' ? ['open', [outFile]] : ['xdg-open', [outFile]];
  spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref();
}
