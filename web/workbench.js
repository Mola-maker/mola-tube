const API="http://localhost:3000";
let jobs=[],audit=[],demo=true,lastKey="";
async function refresh(){
  try{
    const r=await fetch(API+"/api/jobs",{signal:AbortSignal.timeout(1500)});
    if(!r.ok) throw 0; jobs=await r.json(); demo=false;
    const a=await fetch(API+"/api/audit"); audit=await a.json();
  }catch(e){ demo=true; jobs=JSON.parse(localStorage.getItem("molatube_jobs")||"[]"); }
  const key=JSON.stringify({demo,jobs,audit});
  if(key===lastKey) return;
  lastKey=key;
  document.getElementById("mode").textContent=demo?"本地演示模式：后端未连接（启动 node server/index.mjs 后自动切换）。任务只在你的浏览器里模拟，不产生任何外部请求。":"已连接本地 Harness：队列、独立工作区、审计均真实运行。";
  document.getElementById("jobs").innerHTML=jobs.map(j=>`<div class="job"><b>${j.type}</b> · ${j.videoId} · ${j.status}<div class="bar"><i style="width:${j.progress||0}%"></i></div><small>${j.progress||0}% · 工作区 ${j.workspace||"本地演示"} · ${j.result||""}</small><br>${j.status==="running"||j.status==="queued"?`<button class="ghost" onclick="cancelJob('${j.id}')">取消</button>`:""}</div>`).join("")||"<p class='note'>暂无任务。</p>";
  document.getElementById("audit").innerHTML=audit.map(x=>`<div>${x}</div>`).join("")||"暂无记录。";
}
async function createJob(){
  const videoId=document.getElementById("jobVideo").value, type=document.getElementById("jobType").value;
  const question=(document.getElementById("jobQuestion")||{}).value||"";
  if(!demo){ await fetch(API+"/api/jobs",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({videoId,type,question: type==="qa"?question:undefined})}); }
  else{ const j={id:"demo-"+Date.now(),videoId,type,status:"done",progress:100,workspace:"本地演示",result:"演示结果：任务完成（演示模式不调用外部模型）。"}; jobs.unshift(j); localStorage.setItem("molatube_jobs",JSON.stringify(jobs)); }
  refresh();
}
async function cancelJob(id){
  if(!demo) await fetch(API+"/api/jobs/"+id+"/cancel",{method:"POST"});
  else{ jobs=jobs.map(j=>j.id===id?{...j,status:"cancelled"}:j); localStorage.setItem("molatube_jobs",JSON.stringify(jobs)); }
  refresh();
}
const p=JSON.parse(localStorage.getItem("molatube_pending")||"null");
if(p){ localStorage.removeItem("molatube_pending"); setTimeout(()=>{document.getElementById("jobVideo").value=p.videoId;document.getElementById("jobType").value=p.type;createJob();},100); }
// SSE 为主通道；只有 SSE 未接通时才轮询。
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
