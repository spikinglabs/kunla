// Interactive views inside chats (KD-2, KD-10): MCP Apps, the `io.modelcontextprotocol/ui` extension
// (spec 2026-01-26) that claude.ai renders. A tool points at a ui:// resource in `_meta.ui.resourceUri`;
// the host loads that one self-contained HTML file into a sandboxed iframe, hands it the tool result,
// and proxies `tools/call` from the view back to this server. Clients without the extension simply
// show the tool's text, so nothing changes for Claude Code, Codex or the CLI.
//
// No SDK, no CDN, no network from the view (the host's default CSP allows none): the view only talks
// to the host over postMessage, so it works under the strictest sandbox.

export const MIME = 'text/html;profile=mcp-app';
export const PROGRESS_URI = 'ui://kunla/progress';
export const INBOX_URI = 'ui://kunla/inbox';

export const RESOURCES = [
  { uri: PROGRESS_URI, name: 'Kunla project progress', description: 'Counts by status, who is on what, blockers and recent activity.', mimeType: MIME },
  { uri: INBOX_URI, name: 'Kunla decision inbox', description: 'Reviews, questions and proposals waiting on a person, with buttons to decide.', mimeType: MIME },
];

export function readResource(uri: string) {
  const view = uri === PROGRESS_URI ? 'progress' : uri === INBOX_URI ? 'inbox' : null;
  if (!view) return null;
  return { uri, mimeType: MIME, text: page(view), _meta: { ui: { prefersBorder: true } } };
}

const CSS = `
:root{--bg:#fffdf8;--fg:#121212;--mute:#77756c;--line:#e0dcd1;--card:#f4f2ec;--acc:#121212;--lime:#b9ff66;--ok:#1f8a4c;--warn:#b26a00;--bad:#c4372c;
  font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#181816;--fg:#f1efe8;--mute:#8d8a80;--line:#33322e;--card:#222220;--acc:#f1efe8;--ok:#4cc27b;--warn:#f0a83a;--bad:#ff6b5e;color-scheme:dark}}
:root[data-theme=dark]{--bg:#181816;--fg:#f1efe8;--mute:#8d8a80;--line:#33322e;--card:#222220;--acc:#f1efe8;--ok:#4cc27b;--warn:#f0a83a;--bad:#ff6b5e;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;padding:14px 16px;background:var(--bg);color:var(--fg)}
h1{font-size:17px;margin:0 0 2px;letter-spacing:-.01em}h2{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--mute);margin:16px 0 6px}
.sub{color:var(--mute);font-size:12px;margin-bottom:10px}
a,.link{color:var(--acc);text-decoration:underline;text-decoration-color:var(--line);text-underline-offset:3px;cursor:pointer;background:none;border:0;padding:0;font:inherit}
.bar{display:flex;height:10px;border-radius:5px;overflow:hidden;background:var(--line);margin:8px 0 6px}
.bar span{display:block;height:100%}
.legend{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:12px;color:var(--mute)}
.legend i{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:4px}
.row{display:flex;gap:8px;align-items:baseline;padding:5px 0;border-top:1px solid var(--line);font-size:13px}
.row:first-child{border-top:0}.key{color:var(--mute);white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;text-decoration:none}
.grow{flex:1;min-width:0}.pill{font-size:11px;padding:1px 6px;border-radius:9px;background:var(--card);color:var(--mute);white-space:nowrap}
.card{background:var(--card);border-radius:14px;padding:10px 12px;margin:8px 0}
.card .t{font-weight:600}.card .s{color:var(--mute);font-size:13px;margin:4px 0}
.btns{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
button.b{font:inherit;font-size:13px;border:1px solid var(--line);background:var(--bg);color:var(--fg);border-radius:7px;padding:4px 10px;cursor:pointer}
button.b{border-radius:999px;padding:5px 14px}button.b.p{background:var(--lime);border-color:var(--lime);color:#121212;font-weight:600}button.b:disabled{opacity:.5;cursor:default}
textarea{width:100%;font:inherit;font-size:13px;border:1px solid var(--line);border-radius:7px;padding:6px;background:var(--bg);color:var(--fg);margin-top:6px}
.done{color:var(--ok);font-size:13px;margin-top:6px}.err{color:var(--bad);font-size:13px;margin-top:6px}
.empty{color:var(--mute);padding:8px 0}.foot{margin-top:12px;font-size:12px;color:var(--mute);display:flex;gap:12px}
`;

// The view script. `VIEW` is 'progress' or 'inbox'. It renders from the tool result the host sends,
// and refreshes by calling the same tool through the host.
const JS = `
let seq=0;const pending=new Map();let data=null;
const send=(m)=>parent.postMessage(Object.assign({jsonrpc:'2.0'},m),'*');
const req=(method,params)=>new Promise((ok,no)=>{const id=++seq;pending.set(id,{ok,no});send({id,method,params});});
const note=(method,params)=>send({method,params});
const esc=(s)=>String(s??'').replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const $=(s)=>document.querySelector(s);
const open=(url)=>req('ui/open-link',{url}).catch(()=>{});
const fromResult=(r)=>{if(!r)return null;if(r.structuredContent)return r.structuredContent;try{return JSON.parse(r.content[0].text)}catch(e){return null}};
async function tool(name,args){const r=await req('tools/call',{name,arguments:args||{}});if(r&&r.isError)throw new Error((r.content&&r.content[0]&&r.content[0].text)||'Failed');return fromResult(r);}
function theme(ctx){if(ctx&&ctx.theme)document.documentElement.dataset.theme=ctx.theme;}
addEventListener('message',(e)=>{const m=e.data;if(!m||m.jsonrpc!=='2.0')return;
  if(m.id!==undefined&&m.method===undefined){const p=pending.get(m.id);if(!p)return;pending.delete(m.id);m.error?p.no(new Error(m.error.message||'Error')):p.ok(m.result);return;}
  if(m.method==='ui/notifications/tool-result'){const d=fromResult(m.params);if(d){data=d;render();}}
  else if(m.method==='ui/notifications/host-context-changed')theme(m.params);
  else if(m.method==='ui/resource-teardown')send({id:m.id,result:{}});
});
new ResizeObserver(()=>note('ui/notifications/size-changed',{width:Math.ceil(document.body.scrollWidth),height:Math.ceil(document.body.offsetHeight)})).observe(document.body);
document.addEventListener('click',(e)=>{const a=e.target.closest('[data-open]');if(a){e.preventDefault();open(a.dataset.open);}});
(async()=>{try{const r=await req('ui/initialize',{protocolVersion:'2026-01-26',appCapabilities:{availableDisplayModes:['inline']},clientInfo:{name:'kunla-'+VIEW,version:'1'}});theme(r&&r.hostContext);}catch(e){}note('ui/notifications/initialized',{});})();
async function refresh(){const b=$('#refresh');if(b)b.disabled=true;try{data=await tool(VIEW==='inbox'?'decision_inbox':'project_status',VIEW==='progress'&&data&&data.project?{project:data.project.key}:{});render();}catch(e){$('#msg').textContent=e.message;}finally{if(b)b.disabled=false;}}
const taskLink=(k)=>data&&data.board?data.board+'/t/'+k:null;
const keyLink=(k)=>{const u=taskLink(k);return u?'<a href="#" data-open="'+esc(u)+'" class="key">'+esc(k)+'</a>':'<span class="key">'+esc(k)+'</span>';};
const foot=(link)=>'<div class="foot"><button class="link" id="refresh" onclick="refresh()">Refresh</button>'+(link?'<a href="#" data-open="'+esc(link)+'">Open in Kunla</a>':'')+'<span id="msg"></span></div>';
const ago=(iso)=>{const s=(Date.now()-new Date(iso).getTime())/1000;return s<3600?Math.max(1,Math.round(s/60))+'m':s<86400?Math.round(s/3600)+'h':Math.round(s/86400)+'d';};

const COLORS={done:'var(--lime)',review:'var(--fg)',in_progress:'var(--mute)',blocked:'var(--bad)',ready:'var(--line)',inbox:'var(--warn)'};
const LABEL={inbox:'Proposed',ready:'Ready',in_progress:'In progress',blocked:'Blocked',review:'Review',done:'Done'};
const EVENT={claimed:'took',submitted:'sent for review',approved:'approved',changes_requested:'sent back',work_logged:'logged work on',created:'created',answered:'answered',blocked:'asked about',released:'handed off'};
function progress(){const d=data,c=d.counts||{};const order=['done','review','in_progress','blocked','ready','inbox'];
  const total=order.reduce((n,s)=>n+(c[s]||0),0)||1;
  let h='<h1>'+esc(d.project?d.project.name+' ('+d.project.key+')':'All projects')+'</h1>';
  h+='<div class="sub">'+(c.done||0)+' done of '+order.reduce((n,s)=>n+(c[s]||0),0)+' · '+(d.approved_last_7_days||0)+' approved this week'+(d.agent_recorded_share!=null?' · '+d.agent_recorded_share+'% recorded by agents':'')+'</div>';
  h+='<div class="bar">'+order.filter((s)=>c[s]).map((s)=>'<span title="'+LABEL[s]+'" style="width:'+(100*c[s]/total)+'%;background:'+COLORS[s]+'"></span>').join('')+'</div>';
  h+='<div class="legend">'+order.filter((s)=>c[s]).map((s)=>'<span><i style="background:'+COLORS[s]+'"></i>'+LABEL[s]+' '+c[s]+'</span>').join('')+'</div>';
  if((d.blocked||[]).length){h+='<h2>Blocked</h2>'+d.blocked.map((b)=>'<div class="row">'+keyLink(b.key)+'<div class="grow">'+esc(b.title)+(b.question?'<div class="sub" style="margin:2px 0 0">'+esc(b.question)+'</div>':'')+'</div></div>').join('');}
  h+='<h2>Who is on what</h2>';
  h+=(d.who_is_on_what||[]).length?(d.who_is_on_what).map((w)=>'<div class="row"><div class="grow"><b>'+esc(w.member.name)+'</b>'+(w.member.kind==='ai'?' <span class="pill">AI</span>':'')+'<div>'+w.tasks.map((t)=>keyLink(t.key)+' '+esc(t.title)+' <span class="pill">'+LABEL[t.status]+'</span>').join('<br>')+'</div></div></div>').join(''):'<div class="empty">Nobody is on a task right now.</div>';
  const recent=(d.recent||[]).slice(0,8);
  if(recent.length){h+='<h2>Recent</h2>'+recent.map((e)=>'<div class="row"><span class="key">'+ago(e.created_at)+'</span><div class="grow">'+esc(e.actor||'Kunla')+' '+esc(EVENT[e.type]||e.type.replace(/_/g,' '))+' '+keyLink(e.key)+' '+esc(e.title)+'</div></div>').join('');}
  document.body.innerHTML=h+foot(d.link);}

const human=()=>data&&data.me&&data.me.kind==='human';
async function act(i,how){const it=data.items[i],k=it.task.key,box=$('#c'+i),out=$('#o'+i);if(how==='back'&&box&&box.hidden){box.hidden=false;box.focus();return;}const text=box?box.value.trim():'';
  for(const b of document.querySelectorAll('#i'+i+' button'))b.disabled=true;out.className='done';out.textContent='Working…';
  try{let r;const quote={approve:'Approved',back:'Sent back: '+text,answer:text}[how];const src=taskLink(k);
    if(how==='back'&&!text)throw new Error('Say what needs to change.');if(how==='answer'&&!text)throw new Error('Write an answer first.');
    if(how==='confirm'||how==='correct'){if(how==='correct'&&!text)throw new Error('Say what is right instead.');r=await tool('settle_assumption',how==='confirm'?{id:it.assumption.id,confirm:true}:{id:it.assumption.id,correct:text});}
    else if(how==='accept'||how==='decline')r=await tool('triage_proposal',{key:k,accept:how==='accept'});
    else if(human())r=how==='answer'?await tool('answer_question',{key:k,answer:text}):await tool('review_task',{key:k,verdict:how==='approve'?'approved':'changes_requested',comment:text||undefined});
    else r=await tool('record_decision',{key:k,verdict:how==='approve'?'approved':how==='back'?'changes_requested':'answer',source_url:src,quote:quote+' (chosen in the Kunla view in a chat)',comment:how==='back'?text:undefined,answer:how==='answer'?text:undefined});
    out.textContent={approve:'Approved.',back:'Sent back to '+(it.task.assignee&&it.task.assignee.name||'the worker')+'.',answer:'Answered. The task goes back to its worker.',accept:'Accepted.',decline:'Declined.',confirm:'Confirmed.',correct:'Corrected. The work goes back to whoever assumed it.'}[how];
  }catch(e){out.className='err';out.textContent=e.message;for(const b of document.querySelectorAll('#i'+i+' button'))b.disabled=false;}}
function inbox(){const d=data,items=d.items||[];
  let h='<h1>Decision inbox</h1><div class="sub">'+(items.length?items.length+' waiting on '+(human()?'you':'a person'):'Nothing is waiting on a person.')+'</div>';
  const KIND={review:'Review',question:'Question',proposal:'Proposal',flagged:'Stuck in review',assumption:'Assumption'};
  h+=items.map((it,i)=>{const t=it.task;let b='';
    if(it.kind==='review'){const dl=(t.deliverables||[]).map((x)=>'<a href="#" data-open="'+esc(x.url)+'">'+esc(x.title||x.url)+'</a>').join(' · ');
      b='<div class="s">'+esc(t.summary||'')+'</div>'+(dl?'<div class="s">'+dl+'</div>':'')+'<textarea id="c'+i+'" rows="2" placeholder="What needs to change?" hidden></textarea><div class="btns"><button class="b p" onclick="act('+i+',\\'approve\\')">Approve</button><button class="b" onclick="act('+i+',\\'back\\')">Send back</button></div>';}
    else if(it.kind==='question'){b='<div class="s">'+esc(t.blocked_question||'')+'</div><textarea id="c'+i+'" rows="2" placeholder="Your answer"></textarea><div class="btns"><button class="b p" onclick="act('+i+',\\'answer\\')">Answer</button></div>';}
    else if(it.kind==='proposal'){b='<div class="s">'+esc(t.brief||'')+'</div>'+(human()?'<div class="btns"><button class="b p" onclick="act('+i+',\\'accept\\')">Accept</button><button class="b" onclick="act('+i+',\\'decline\\')">Decline</button></div>':'<div class="s">Accept or decline it in Kunla.</div>');}
    else if(it.kind==='assumption'){b='<div class="s">'+esc((it.assumption.made_by&&it.assumption.made_by.name)||'An agent')+' went ahead assuming: “'+esc(it.assumption.text)+'”</div><textarea id="c'+i+'" rows="2" placeholder="If that is wrong, what is right?"></textarea><div class="btns"><button class="b p" onclick="act('+i+',\'confirm\')">Confirm</button><button class="b" onclick="act('+i+',\'correct\')">Correct</button></div>';}
    else b='<div class="s">'+t.review_rounds+' review rounds so far. Worth a look.</div>';
    return '<div class="card" id="i'+i+'"><div>'+keyLink(t.key)+' <span class="pill">'+KIND[it.kind]+'</span></div><div class="t">'+esc(t.title)+'</div>'+(t.assignee?'<div class="sub" style="margin:0">'+esc(t.assignee.name)+'</div>':'')+b+'<div id="o'+i+'"></div></div>';}).join('');
  document.body.innerHTML=h+foot(d.board?d.board+'/app/':null);}
function render(){if(!data)return;VIEW==='inbox'?inbox():progress();}
`;

function page(view: 'progress' | 'inbox') {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kunla</title><style>${CSS}</style></head><body><div class="empty">Loading…</div>
<script>const VIEW=${JSON.stringify(view)};${JS}</script></body></html>`;
}
