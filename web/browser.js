const API="";
let lastKey="";
async function api(method,p,body){
  const r=await fetch(API+p,{method,headers:{"Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});
  const d=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(d.error||("HTTP "+r.status));
  return d;
}
async function refresh(){
  let tabs=[],health={up:false};
  try{ tabs=await api("GET","/api/browser/tabs"); }catch(e){ tabs=[]; }
  try{ health=await api("GET","/api/browser/health"); }catch(e){ health={up:false}; }
  const key=JSON.stringify({tabs,health});
  if(key===lastKey) return;
  lastKey=key;
  document.getElementById("mode").textContent=health.up?`浏览器引擎已连接，当前 ${tabs.length} 个标签页（本沙箱上限见服务端配置）。`:"浏览器引擎未连接：点「刷新」重试，或检查服务端是否以 MOLATUBE_BROWSER=0 启动。";
  document.getElementById("tabs").innerHTML=tabs.length?tabs.map(t=>`
    <div class="card">
      <div class="thumb">🌐</div>
      <h3>${(t.title||"(无标题)").slice(0,40)}</h3>
      <p>${t.url}</p>
      <p class="note">agent: ${t.agent} · ${new Date(t.createdAt).toLocaleTimeString()}</p>
      <div class="row">
        <button class="btn" onclick="readTab('${t.tabId}')">读取</button>
        <button class="btn ghost" onclick="shotTab('${t.tabId}')">截图</button>
        <button class="btn ghost" onclick="closeTab('${t.tabId}')">关闭</button>
      </div>
    </div>`).join(""):`<p class="note">暂无标签页。在上方输入网址开一个，或让 agent 通过 browser_open_tab 插件任务来开。</p>`;
}
async function openTab(){
  const url=document.getElementById("tabUrl").value.trim();
  if(!url) return;
  try{ await api("POST","/api/browser/open",{url}); refresh(); }
  catch(e){ document.getElementById("readOut").textContent="打开失败："+e.message; }
}
async function closeTab(id){
  try{ await api("POST","/api/browser/"+encodeURIComponent(id)+"/close",{}); refresh(); }
  catch(e){ document.getElementById("readOut").textContent="关闭失败："+e.message; }
}
async function readTab(id){
  try{
    const d=await api("GET","/api/browser/"+encodeURIComponent(id)+"/read");
    document.getElementById("readOut").textContent=`标题：${d.title}\n地址：${d.url}\n\n${d.text||""}`;
  }catch(e){ document.getElementById("readOut").textContent="读取失败："+e.message; }
}
async function shotTab(id){
  try{
    const d=await api("POST","/api/browser/"+encodeURIComponent(id)+"/screenshot",{});
    const b64=d.imageBase64||d.pngBase64||"";
    document.getElementById("shotWrap").innerHTML=`<img src="data:image/jpeg;base64,${b64}" style="max-width:100%;border-radius:12px">`;
  }catch(e){ document.getElementById("readOut").textContent="截图失败："+e.message; }
}
refresh(); setInterval(refresh,3000);
