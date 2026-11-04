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
// Read-only, binds to localhost, serves only .md files inside the repository.
// No dependencies, Node 18+. This is team tooling, not part of the product.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

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
const SKIP_DIRS = new Set(['node_modules', '.git', 'bin', 'obj', '.board']);

// ---------- scanning ----------
const posix = (p) => p.split(sep).join('/');

function listMd(dir) {
  const abs = join(root, dir);
  let names;
  try { names = readdirSync(abs); } catch { return []; }
  return names.filter((n) => n.toLowerCase().endsWith('.md')).sort().map((n) => `${dir}/${n}`);
}

function describe(path) {
  const abs = join(root, path);
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
  return { path, file, title, id: fm.id || '', parent, status: fm.status || '', priority: fm.id ? fm.priority || 'P2' : '', mtime: statSync(abs).mtimeMs };
}

function scan() {
  const areas = AREAS.map((a) => {
    const paths = a.files ? a.files.filter((f) => { try { statSync(join(root, f)); return true; } catch { return false; } }) : listMd(a.dir);
    return { id: a.id, label: a.label, items: paths.map(describe) };
  });
  // anything else with .md that no area claims (e.g. a README in a new folder) still gets a home
  const claimed = new Set(areas.flatMap((a) => a.items.map((i) => i.path)));
  const extra = [];
  (function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(join(dir, e.name)); }
      else if (e.name.toLowerCase().endsWith('.md')) {
        const p = posix(relative(root, join(dir, e.name)));
        if (!claimed.has(p)) extra.push(describe(p));
      }
    }
  })(root);
  if (extra.length) areas.find((a) => a.id === 'other').items.push(...extra.sort((a, b) => a.path.localeCompare(b.path)));
  const version = areas.flatMap((a) => a.items).map((i) => `${i.path}:${i.mtime}`).join('|');
  return { areas, version };
}

// ---------- server ----------
const send = (res, code, type, body) => { res.writeHead(code, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' }); res.end(body); };

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/') return send(res, 200, 'text/html', PAGE);
    if (url.pathname === '/api/index') return send(res, 200, 'application/json', JSON.stringify(scan()));
    if (url.pathname === '/api/file') {
      const rel = url.searchParams.get('path') ?? '';
      const abs = resolve(root, rel);
      if (!rel.toLowerCase().endsWith('.md') || !abs.startsWith(root + sep) || abs.split(sep).some((s) => SKIP_DIRS.has(s))) return send(res, 403, 'text/plain', 'forbidden');
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
main{max-width:1700px;margin:0 auto;padding:20px 16px 80px}
article{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:8px 28px 28px;overflow-wrap:anywhere}
.path{font:12px ui-monospace,Consolas,monospace;color:var(--muted);margin:10px 0 0}
.fm{border:1px solid var(--line);border-radius:8px;margin:14px 0;font-size:13px;overflow:hidden}
.fm div{display:flex;gap:10px;padding:4px 10px;border-top:1px solid var(--line)}.fm div:first-child{border-top:0}
.fm b{flex:0 0 120px;color:var(--muted);font-weight:500}
h1,h2,h3,h4{line-height:1.3;margin:1.6em 0 .5em}h1{font-size:1.7em;margin-top:.8em}h2{font-size:1.35em;border-bottom:1px solid var(--line);padding-bottom:.2em}h3{font-size:1.1em}
a{color:var(--accent)}
code{background:var(--code);padding:.1em .35em;border-radius:4px;font:.88em ui-monospace,Consolas,monospace}
pre{background:var(--code);padding:12px 14px;border-radius:8px;overflow:auto}pre code{background:none;padding:0}
blockquote{margin:1em 0;padding:.1em 1em;border-left:4px solid var(--quote);color:var(--muted)}
table{border-collapse:collapse;display:block;overflow:auto;margin:1em 0}th,td{border:1px solid var(--line);padding:5px 10px;text-align:left;vertical-align:top}th{background:var(--code)}
hr{border:0;border-top:1px solid var(--line);margin:1.6em 0}
img{max-width:100%}ul,ol{padding-left:1.5em}li.task{list-style:none;margin-left:-1.3em}li.task input{margin-right:.5em}
.empty{color:var(--muted);padding:40px 0;text-align:center}
</style></head><body>
<header><h1>Project docs</h1><div id="picks"></div><span class="live" id="live">connecting…</span></header>
<main><article id="doc"><p class="empty">Pick a document from one of the lists above.</p></article></main>
<script>
const $=(s)=>document.querySelector(s);
const esc=(s)=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
let index=null,current=null,currentText=null;

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
function render(text,path){
  let fm='';
  const m=text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if(m){fm='<div class="fm">'+m[1].split(/\r?\n/).map(l=>{const kv=l.match(/^([A-Za-z_]+):\s*(.*)$/);return kv?'<div><b>'+esc(kv[1])+'</b><span>'+esc(kv[2])+'</span></div>':''}).join('')+'</div>';text=m[2]}
  const el=$('#doc');
  el.innerHTML='<p class="path">'+esc(path)+'</p>'+fm+md(text);
  // links to other .md files stay inside the viewer; other relative links are shown as text
  const base=path.split('/').slice(0,-1);
  el.querySelectorAll('a[href]').forEach(a=>{
    const h=a.getAttribute('href');
    if(/^(https?:|mailto:)/.test(h)){a.target='_blank';a.rel='noopener';return}
    const [file,hash]=h.split('#');
    if(!file){a.setAttribute('href','#'+encodeURIComponent(path)+(hash?'/'+hash:''));return}
    const parts=file.startsWith('/')?[]:base.slice();
    for(const p of decodeURI(file).split('/')){if(p==='..')parts.pop();else if(p&&p!=='.')parts.push(p)}
    const target=parts.join('/');
    if(/\.md$/i.test(target))a.setAttribute('href','#'+encodeURIComponent(target));
    else{a.removeAttribute('href');a.style.color='var(--muted)';a.title=target}
  });
}

// ---------- navigation ----------
function areaOf(path){return index&&index.areas.find(a=>a.items.some(i=>i.path===path))}
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
  const all=index.areas.flatMap(a=>a.items);
  list(roots);
  for(const [p,items] of groups){const owner=all.find(i=>i.id===p);rows.push({group:p+(owner?' · '+owner.title:'')});list(items)}
  // members of a parent cycle are never reached from a root: still list them
  const left=area.items.filter(i=>!seen.has(i));
  if(left.length){rows.push({group:'Other'});list(left)}
  return rows;
}
function rowHtml(r){
  if(r.group)return '<div class="grp">'+esc(r.group)+'</div>';
  const i=r.item,m=i.file.match(/^(BL-\d+)(.*)$/);
  const name=m?'<b>'+esc(m[1])+'</b>'+esc(m[2]):esc(i.file);
  const q=[i.file,i.title,i.id,i.status,i.priority].join(' ').toLowerCase();
  return '<div class="row" role="option" tabindex="-1" data-path="'+esc(i.path)+'" data-q="'+esc(q)+'"><span class="tree">'+esc(r.prefix)+'</span><span class="name">'+name+'</span>'+
    (i.priority?'<span class="prio p-'+esc(i.priority)+'">'+esc(i.priority)+'</span>':'')+
    (i.status?'<span class="st st-'+esc(i.status)+'">'+esc(i.status)+'</span>':'')+'</div>';
}
// One dropdown per area: a button that opens a panel with roomy, larger rows.
function buildPicks(){
  const wrap=$('#picks');wrap.style.display='contents';
  wrap.innerHTML=index.areas.filter(a=>a.items.length).map(a=>'<div class="pick" data-a="'+a.id+'"><span class="lbl">'+esc(a.label)+' ('+a.items.length+')</span>'+
    '<button type="button" class="dd" aria-haspopup="listbox" aria-expanded="false"><span class="ddt">— select —</span><span class="car">▾</span></button>'+
    '<div class="panel" role="listbox" hidden><div class="find"><input type="search" placeholder="Search (id, title, status, P0...)" aria-label="Search '+esc(a.label)+'" autocomplete="off" spellcheck="false"></div>'+
    rowsOf(a).map(rowHtml).join('')+'<div class="nomatch" hidden>No match</div></div></div>').join('');
  wrap.onclick=(e)=>{
    const b=e.target.closest('.dd');if(b){togglePanel(b.closest('.pick'));return}
    const r=e.target.closest('.row');if(r){location.hash=encodeURIComponent(r.dataset.path);closePanels()}
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
    const sel=panel.querySelector('.row.sel');if(sel)sel.scrollIntoView({block:'center'});
    const box=panel.querySelector('.find input');box.value='';filterPanel(p,'');box.focus({preventScroll:true});
  }
}
function markActive(){
  const a=current&&areaOf(current);
  document.querySelectorAll('.pick').forEach(p=>{
    const on=!!a&&p.dataset.a===a.id;p.classList.toggle('active',on);
    p.querySelectorAll('.row').forEach(r=>r.classList.toggle('sel',on&&r.dataset.path===current));
    const item=on&&a.items.find(i=>i.path===current);
    p.querySelector('.ddt').textContent=item?item.file:'— select —';
  });
}
async function open(path,force){
  if(path===current&&!force)return;
  const r=await fetch('/api/file?path='+encodeURIComponent(path));
  if(!r.ok){$('#doc').innerHTML='<p class="empty">Cannot open '+esc(path)+' ('+r.status+')</p>';return}
  const text=await r.text();
  const moved=path!==current;current=path;
  if(!moved&&text===currentText)return;
  const y=window.scrollY;currentText=text;render(text,path);markActive();
  document.title=path.split('/').pop().replace(/\.md$/i,'')+' · Project docs';
  window.scrollTo(0,moved?0:y);
}
function route(){
  const h=decodeURIComponent(location.hash.slice(1)).replace(/(\.md)\/.*$/i,'$1');
  if(/\.md$/i.test(h))open(h);
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
}
poll();setInterval(poll,2000);
</script></body></html>`;
