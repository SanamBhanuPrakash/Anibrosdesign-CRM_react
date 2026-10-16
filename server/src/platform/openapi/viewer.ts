/**
 * Dependency-free API reference viewer. Served at /api/docs with its own nonce-based CSP (no CDN, no third-party code),
 * rendering the live OpenAPI document so the reference is always the deployed truth.
 */
export function docsHtml(nonce: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Anibros CRM API Reference</title>
<style nonce="${nonce}">
:root{--bg:#faf9f5;--panel:#fff;--ink:#1c1c1a;--mute:#6b6a64;--line:#e7e5dc;--acc:#1f6f5c;--code:#f1efe7}
@media(prefers-color-scheme:dark){:root{--bg:#181816;--panel:#21211e;--ink:#ecebe5;--mute:#a09f97;--line:#34332f;--acc:#59b59d;--code:#2a2a26}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:flex;min-height:100vh}
nav{width:320px;flex:none;border-right:1px solid var(--line);background:var(--panel);height:100vh;position:sticky;top:0;overflow:auto;padding:16px}
nav h1{font-size:16px;margin:0 0 4px}nav input{width:100%;padding:8px 10px;margin:8px 0 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)}
nav h2{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--mute);margin:16px 0 4px}
nav a{display:flex;gap:8px;align-items:center;padding:5px 8px;border-radius:6px;color:var(--ink);text-decoration:none;font-size:13px;cursor:pointer}
nav a:hover,nav a.on{background:var(--code)}
.m{font:600 10px ui-monospace,monospace;padding:2px 6px;border-radius:4px;color:#fff;min-width:46px;text-align:center}
.get{background:#2b7a4b}.post{background:#1f6f5c}.patch{background:#a86a12}.put{background:#a86a12}.delete{background:#b3372f}
main{flex:1;max-width:900px;padding:32px 40px 80px}
h2.t{margin:0 0 4px;font-size:22px}code,pre{font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--code);border-radius:6px}
code{padding:1px 5px}pre{padding:12px;overflow:auto;border:1px solid var(--line)}
table{border-collapse:collapse;width:100%;margin:8px 0 16px;font-size:13px}th,td{text-align:left;border-bottom:1px solid var(--line);padding:6px 8px;vertical-align:top}th{color:var(--mute);font-weight:600}
.pill{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:1px 9px;font-size:12px;color:var(--mute);margin-right:6px}
.path{font:600 15px ui-monospace,monospace}h3{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--mute);margin:24px 0 6px}
.intro{border-bottom:1px solid var(--line);margin-bottom:24px;padding-bottom:12px}
@media(max-width:800px){body{display:block}nav{width:auto;height:auto;position:static}main{padding:20px}}
</style></head><body>
<nav><h1>Anibros CRM API</h1><div id="ver" style="color:var(--mute);font-size:12px"></div><input id="q" placeholder="Filter endpoints…" aria-label="Filter endpoints"><div id="nav"></div></nav>
<main id="main"><p>Loading…</p></main>
<script nonce="${nonce}">
(async function(){
var esc=function(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]})};
var md=function(s){return esc(s).replace(/\\*\\*(.+?)\\*\\*/g,'<b>$1</b>').replace(/\`([^\`]+)\`/g,'<code>$1</code>').split(/\\n\\n+/).map(function(p){return '<p>'+p.replace(/\\n/g,'<br>')+'</p>'}).join('')};
var spec=await (await fetch('/api/v1/openapi.json')).json();
document.getElementById('ver').textContent='OpenAPI '+spec.openapi+' · v'+spec.info.version;
var ops=[];Object.keys(spec.paths).forEach(function(p){Object.keys(spec.paths[p]).forEach(function(m){ops.push({p:p,m:m,o:spec.paths[p][m]})})});
var intro='<div class="intro"><h2 class="t">'+esc(spec.info.title)+'</h2>'+md(spec.info.description)+'</div>';
function schemaPre(s){return '<pre>'+esc(JSON.stringify(s,null,2))+'</pre>'}
function show(i){
  var x=ops[i],o=x.o,h='<h2 class="t">'+esc(o.summary)+'</h2><div><span class="m '+x.m+'">'+x.m.toUpperCase()+'</span> <span class="path">'+esc(x.p)+'</span></div><p>';
  (o['x-required-permissions']||[]).forEach(function(p){h+='<span class="pill">needs '+esc(p)+'</span>'});
  h+=(o.security&&o.security.length===0?'<span class="pill">public</span>':'<span class="pill">authenticated</span>')+(o['x-idempotent']?'<span class="pill">idempotent</span>':'')+'</p>'+(o.description?md(o.description):'');
  if(o.parameters&&o.parameters.length){h+='<h3>Parameters</h3><table><tr><th>Name</th><th>In</th><th>Type</th><th>Required</th></tr>';o.parameters.forEach(function(q){h+='<tr><td><code>'+esc(q.name)+'</code></td><td>'+q.in+'</td><td>'+esc(q.schema&&q.schema.type||'')+'</td><td>'+(q.required?'yes':'')+'</td></tr>'});h+='</table>'}
  if(o.requestBody){h+='<h3>Request body</h3>'+schemaPre(o.requestBody.content['application/json'].schema)}
  h+='<h3>Responses</h3><table><tr><th>Status</th><th>Meaning</th></tr>';Object.keys(o.responses).forEach(function(c){h+='<tr><td><code>'+c+'</code></td><td>'+esc(o.responses[c].description)+'</td></tr>'});h+='</table>';
  var body=o.requestBody?" \\\\\\n  -H 'Content-Type: application/json' \\\\\\n  -d '{ ... }'":'';
  h+='<h3>Example</h3><pre>curl -X '+x.m.toUpperCase()+' "$BASE_URL'+esc(x.p)+'" \\\\\\n  -H "Authorization: Bearer $CRM_API_KEY"'+body+'</pre>';
  document.getElementById('main').innerHTML=h;history.replaceState(null,'','#'+i);
  document.querySelectorAll('nav a').forEach(function(a){a.classList.toggle('on',a.dataset.i==i)});
}
function nav(f){
  var groups={};ops.forEach(function(x,i){if(f&&(x.p+x.o.summary).toLowerCase().indexOf(f)<0)return;var t=(x.o.tags||['Other'])[0];(groups[t]=groups[t]||[]).push(i)});
  var h='';Object.keys(groups).forEach(function(t){h+='<h2>'+esc(t)+'</h2>';groups[t].forEach(function(i){var x=ops[i];h+='<a data-i="'+i+'"><span class="m '+x.m+'">'+x.m.toUpperCase()+'</span>'+esc(x.o.summary)+'</a>'})});
  var el=document.getElementById('nav');el.innerHTML=h;el.querySelectorAll('a').forEach(function(a){a.onclick=function(){show(+a.dataset.i)}});
}
nav('');document.getElementById('q').oninput=function(e){nav(e.target.value.toLowerCase())};
var start=parseInt(location.hash.slice(1),10);
if(isNaN(start))document.getElementById('main').innerHTML=intro+'<p>Select an endpoint from the list.</p><h3>Webhook events</h3><table><tr><th>Event</th><th>When</th></tr>'+Object.keys(spec.webhooks||{}).map(function(k){return '<tr><td><code>'+esc(k)+'</code></td><td>'+esc((spec.webhooks[k].post.description||'').split('\\n')[0])+'</td></tr>'}).join('')+'</table>';else show(start);
})().catch(function(e){document.getElementById('main').textContent='Failed to load API description: '+e.message});
</script></body></html>`;
}
