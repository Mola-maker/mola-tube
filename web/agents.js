const API="http://localhost:3000";
let agents=[],jobs=[],audit=[],demo=true,lastKey="";
function esc(s){return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;");}
function jobOf(a){return jobs.find(j=>j.id===a.currentJobId)||jobs.filter(j=>j.agentId===a.id)[0];}
function card(a){
  const j=jobOf(a);
  const btns=[];
  if(a.status==="idle"||a.status==="waiting") btns.push(`<button class="btn" onclick="act('${a.id}','start')">开始</button>`);
  if(a.status==="working") btns.push(`<button class="ghost" onclick="act('${a.id}','pause')">暂停（跑完当前）</button>`);
  if(a.status==="paused") btns.push(`<button class="btn" onclick="act('${a.id}','resume')">恢复</button>`);
  if(a.status!=="stopped") btns.push(`<button class="ghost" onclick="act('${a.id}','stop')">停止</button>`);
  if(a.status==="waiting") btns.push(`<button class="btn" onclick="act('${a.id}','retry')">重试</button>`);
  return `<div class="job"><b>${esc(a.name)}</b> · ${a.type} · ${a.videoId} · <b>${a.status}</b>${j?`<div class="bar"><i style="width:${j.progress||0}%"></i></div><small>${j.progress||0}% · ${esc(j.step||"")} · ${esc(j.result||"")}</small>`:""}<br><input id="note-${a.id}" placeholder="给这个 agent 留备注…"> <button class="ghost" onclick="note('${a.id}')">备注</button> ${btns.join(" ")}</div>`;
}
async function refresh(){
  try{
    const [ra,rj,rh,rau]=await Promise.all([
      fetch(API+"/api/agents",{signal:AbortSignal.timeout(1500)}),
      fetch(API+"/api/jobs",{signal:AbortSignal.timeout(1500)}),
      fetch(API+"/api/health",{signal:AbortSignal.timeout(1500)}),
      fetch(API+"/api/audit",{signal:AbortSignal.timeout(1500)})]);
    if(!ra.ok) throw 0;
    agents=await ra.json(); jobs=await rj.json(); audit=await rau.json(); demo=false;
    const h=await rh.json();
    document.getElementById("healthBody").textContent=`运行中 ${h.running} / 上限 ${h.caps.MAX_RUNNING} · 排队 ${h.queued} / 上限 ${h.caps.QUEUE_MAX} · 每用户上限 ${h.caps.PER_USER_RUNNING} · Agents ${h.agents}`;
  }catch(e){
    demo=true;
    document.getElementById("healthBody").textContent="后端未连接：启动 node server/index.mjs 后自动切换。";
  }
  // 状态没变就不重写 DOM，避免轮询/SSE 双通道下的闪烁与重排。
  const key=JSON.stringify({demo,agents,jobs,audit});
  if(key===lastKey) return;
  lastKey=key;
  document.getElementById("mode").textContent=demo?"本地演示模式：后端未连接，创建的 agent 只存在浏览器里，不产生外部请求。":"已连接本地 Harness：状态持久化、子进程隔离、SSE 实时推送。";
  const waiting=agents.filter(a=>a.status==="waiting");
  document.getElementById("waiting").innerHTML=waiting.map(card).join("")||"<p class='note'>没有等你处理的 agent。</p>";
  document.getElementById("agents").innerHTML=agents.map(card).join("")||"<p class='note'>暂无 agent，先创建一个。</p>";
  document.getElementById("audit").innerHTML=audit.map(x=>`<div>${esc(x)}</div>`).join("")||"暂无记录。";
}
async function createAgent(){
  const name=document.getElementById("agentName").value, videoId=document.getElementById("agentVideo").value, type=document.getElementById("agentType").value;
  if(demo){ agents.unshift({id:"demo-"+Date.now(),name:name||"演示 Agent",type,videoId,status:"idle"}); refresh(); return; }
  await fetch(API+"/api/agents",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name,type,videoId})});
  refresh();
}
async function act(id,action){
  if(demo){ const a=agents.find(x=>x.id===id); if(a){ if(action==="start")a.status="working"; if(action==="pause")a.status="paused"; if(action==="resume")a.status="idle"; if(action==="stop")a.status="stopped"; if(action==="retry")a.status="idle"; } refresh(); return; }
  await fetch(`${API}/api/agents/${id}/${action}`,{method:"POST"});
  refresh();
}
async function note(id){
  const el=document.getElementById("note-"+id); const text=el.value.trim(); if(!text) return;
  if(!demo) await fetch(`${API}/api/agents/${id}/note`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({text})});
  el.value=""; refresh();
}
(function init(){
  const sel=document.getElementById("agentVideo");
  if(sel&&typeof VIDEOS!=="undefined") sel.innerHTML=VIDEOS.map(x=>`<option value="${x.id}">${x.title}</option>`).join("");
  // SSE 为主通道；只有 SSE 未接通时才轮询，避免双通道重复刷新。
  let pollTimer=null;
  const startPoll=()=>{ if(!pollTimer) pollTimer=setInterval(refresh,2000); };
  const stopPoll=()=>{ if(pollTimer){ clearInterval(pollTimer); pollTimer=null; } };
  try{
    const es=new EventSource(API+"/api/events");
    es.onopen=()=>stopPoll();
    es.onmessage=()=>refresh();
    es.onerror=()=>startPoll();
  }catch(e){ startPoll(); }
  refresh(); startPoll();
})();
