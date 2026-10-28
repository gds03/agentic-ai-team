#!/usr/bin/env node
// Docs viewer: browse every .md of the project (backlog, specs, ADRs, research, ...) in the browser.
//
//   node tools/docs.mjs                  serve on http://127.0.0.1:4747
//   node tools/docs.mjs --open           ...and open it in the browser
//   node tools/docs.mjs --port 5000      other port
//
// One dropdown per area; pick an item to jump into it. New, renamed or edited files show up on
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
  return { path, file, title, status: fm.status || '', mtime: statSync(abs).mtimeMs };
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
:root{--bg:#f6f7f9;--panel:#fff;--ink:#1c2230;--muted:#667085;--line:#e2e5ea;--accent:#2f5bea;--code:#f0f2f5;--quote:#c9d3f5}
@media(prefers-color-scheme:dark){:root{--bg:#14171d;--panel:#1c2028;--ink:#e6e9ef;--muted:#98a2b3;--line:#2b313c;--accent:#7b9bff;--code:#252b35;--quote:#3a4a86}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
header{position:sticky;top:0;z-index:5;background:var(--panel);border-bottom:1px solid var(--line);padding:10px 16px;display:flex;flex-wrap:wrap;gap:10px 14px;align-items:flex-end}
header h1{font-size:16px;margin:0 6px 6px 0;align-self:center}
.pick{display:flex;flex-direction:column;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;min-width:0}
.pick select{margin-top:2px;max-width:min(300px,80vw);font:13px system-ui;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:5px 6px;text-transform:none;letter-spacing:0}
.pick.active select{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
.live{margin-left:auto;font-size:12px;color:var(--muted);align-self:center}
main{max-width:900px;margin:0 auto;padding:20px 16px 80px}
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
function buildPicks(){
  const wrap=$('#picks');wrap.style.display='contents';
  wrap.innerHTML=index.areas.filter(a=>a.items.length).map(a=>'<label class="pick" data-a="'+a.id+'">'+esc(a.label)+' ('+a.items.length+')<select data-a="'+a.id+'"><option value="">— select —</option>'+
    a.items.map(i=>{const t=i.file;
      return '<option value="'+esc(i.path)+'">'+esc(t+(i.status?' ['+i.status+']':''))+'</option>'}).join('')+'</select></label>').join('');
  wrap.querySelectorAll('select').forEach(s=>s.onchange=()=>{if(s.value)location.hash=encodeURIComponent(s.value)});
  markActive();
}
function markActive(){
  const a=current&&areaOf(current);
  document.querySelectorAll('.pick').forEach(p=>{const on=a&&p.dataset.a===a.id;p.classList.toggle('active',!!on);const s=p.querySelector('select');s.value=on?current:''});
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
