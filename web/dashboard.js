const API="";
function key(){return localStorage.getItem("molatube_key")||"";}
function headers(){return {"Content-Type":"application/json",...(key()?{"X-Api-Key":key()}:{})};}
async function api(method,p,body){
  const r=await fetch(API+p,{method,headers:headers(),body:body?JSON.stringify(body):undefined});
  const d=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(d.error||("HTTP "+r.status));
  return d;
}
function esc(s){return String(s??"").replace(/&/g,"&amp;").replace(/</g,"&lt;");}
function showTab(id,btn){
  document.querySelectorAll(".tab").forEach(t=>t.classList.remove("on"));
  document.getElementById("tab-"+id).classList.add("on");
  document.querySelectorAll(".side2 button").forEach(b=>b.classList.remove("on"));
  if(btn)btn.classList.add("on");
}
function saveKey(){const v=document.getElementById("apiKeyInput").value.trim(); if(v)localStorage.setItem("molatube_key",v); else localStorage.removeItem("molatube_key"); refresh();}
let auditCache=[];
async function refresh(){
  try{
    const [stats,health,channels,keysList,audit,quotas]=await Promise.all([api("GET","/api/stats"),api("GET","/api/health"),api("GET","/api/channels"),api("GET","/api/keys"),api("GET","/api/audit"),api("GET","/api/quotas")]);
    document.getElementById("statCards").innerHTML=`<div class="stat"><b>${stats.agents.total}</b>Agents</div><div class="stat"><b>${stats.jobs.total}</b>任务总数</div><div class="stat"><b>${stats.running}</b>运行中</div><div class="stat"><b>${stats.queued}</b>排队中</div><div class="stat"><b>${channels.length}</b>渠道</div><div class="stat"><b>${keysList.length}</b>令牌</div>`;
    const max=Math.max(1,...stats.last14Days.map(d=>d.count));
    document.getElementById("chart").innerHTML=stats.last14Days.map(d=>`<div style="height:${Math.round(d.count/max*110)+2}px" title="${d.date}: ${d.count}"></div>`).join("");
    document.getElementById("chartLabels").textContent=stats.last14Days.map(d=>`${d.date.slice(5)}:${d.count}`).join("  ");
    document.getElementById("dist").innerHTML=`按状态：${Object.entries(stats.jobs.byStatus).map(([k,v])=>`${k} ${v}`).join(" · ")||"无"}<br>按类型：${Object.entries(stats.jobs.byType).map(([k,v])=>`${k} ${v}`).join(" · ")||"无"}<br>按渠道：${Object.entries(stats.jobs.byChannel).map(([k,v])=>`${k} ${v}`).join(" · ")||"无"}`;
    document.getElementById("chRows").innerHTML=channels.map(c=>`<tr><td>${esc(c.name)}</td><td>${c.type}</td><td><input type="number" value="${c.priority}" style="width:70px" onchange="patchChannel('${c.id}',{priority:Number(this.value)})"></td><td><input type="number" value="${c.weight}" style="width:70px" onchange="patchChannel('${c.id}',{weight:Number(this.value)})"></td><td><input type="checkbox" ${c.enabled?"checked":""} onchange="patchChannel('${c.id}',{enabled:this.checked})"></td><td><button class="ghost" onclick="testChannel('${c.id}')">测试</button> ${c.builtin?"":"<button class=\"ghost\" onclick=\"delChannel('"+c.id+"')\">删除</button>"} <span id="test-${c.id}"></span></td></tr>`).join("");
    document.getElementById("keyRows").innerHTML=keysList.map(k=>`<tr><td>${esc(k.name)}</td><td>${esc(k.key)}</td><td>${k.quota}</td><td>${k.used}</td><td>${k.enabled?"启用":"已吊销"}</td><td>${k.enabled?`<button class="ghost" onclick="revokeKey('${k.id}')">吊销</button>`:""}</td></tr>`).join("")||"<tr><td colspan=6>暂无令牌</td></tr>";
    auditCache=audit; renderLogs();
    document.getElementById("qAgents").value=quotas.maxAgents; document.getElementById("qJobs").value=quotas.maxJobsPerDay;
    document.getElementById("caps").textContent=`MAX_RUNNING=${health.caps.MAX_RUNNING} · PER_USER_RUNNING=${health.caps.PER_USER_RUNNING} · QUEUE_MAX=${health.caps.QUEUE_MAX} · JOB_TIMEOUT_MS=${health.caps.JOB_TIMEOUT_MS}`;
  }catch(e){
    document.getElementById("statCards").innerHTML=`<p class="note">后端未连接：请先启动 node server/index.mjs，再打开 http://localhost:3000/web/dashboard.html。错误：${esc(e.message)}</p>`;
  }
}
function renderLogs(){
  const q=(document.getElementById("logFilter").value||"").toLowerCase();
  document.getElementById("logs").innerHTML=auditCache.filter(x=>!q||x.toLowerCase().includes(q)).slice().reverse().map(x=>`<div>${esc(x)}</div>`).join("")||"暂无记录。";
}
async function addChannel(){
  try{ await api("POST","/api/channels",{name:document.getElementById("chName").value,type:document.getElementById("chType").value,priority:Number(document.getElementById("chPriority").value),weight:Number(document.getElementById("chWeight").value),endpoint:document.getElementById("chEndpoint").value}); refresh(); }
  catch(e){ alert(e.message); }
}
async function patchChannel(id,patch){ try{ await api("PATCH","/api/channels/"+id,patch); refresh(); }catch(e){ alert(e.message); } }
async function delChannel(id){ if(!confirm("删除该渠道？"))return; await api("DELETE","/api/channels/"+id); refresh(); }
async function testChannel(id){ try{ const r=await api("POST","/api/channels/"+id+"/test"); document.getElementById("test-"+id).textContent=r.ok?"✓ 通过":"✗ 失败"; }catch(e){ document.getElementById("test-"+id).textContent="✗ "+e.message; } }
async function addKey(){
  try{
    const r=await api("POST","/api/keys",{name:document.getElementById("keyName").value,quota:Number(document.getElementById("keyQuota").value)});
    document.getElementById("newKeyBanner").innerHTML=`<div class="panel">新令牌（只显示一次，请立即复制）：<b>${esc(r.plain)}</b> <button class="btn" onclick="navigator.clipboard.writeText('${r.plain}')">复制</button></div>`;
    refresh();
  }catch(e){ alert(e.message); }
}
async function revokeKey(id){ await api("POST","/api/keys/"+id+"/revoke"); refresh(); }
async function saveQuotas(){ try{ await api("PATCH","/api/quotas",{maxAgents:Number(document.getElementById("qAgents").value),maxJobsPerDay:Number(document.getElementById("qJobs").value)}); alert("已保存"); }catch(e){ alert(e.message); } }
(function(){ const k=key(); if(k) document.getElementById("apiKeyInput").value=k; refresh(); setInterval(refresh,3000); })();
