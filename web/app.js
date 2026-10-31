const VIDEOS=[
{id:"v1",title:"线性代数：矩阵乘法到底在算什么",author:"Mola 数学",views:"12万次",time:"18:24",emoji:"🧮",desc:"从几何直觉讲矩阵乘法，适合线代入门。"},
{id:"v2",title:"操作系统：进程与线程，一次讲清",author:"Mola CS",views:"8.2万次",time:"24:10",emoji:"💻",desc:"进程、线程、调度，用生活例子讲明白。"},
{id:"v3",title:"机器学习：梯度下降为什么能走下山",author:"Mola ML",views:"21万次",time:"15:47",emoji:"📉",desc:"梯度、学习率、局部最优的直觉版。"},
{id:"v4",title:"信号与系统：傅里叶变换的直觉",author:"Mola 信号",views:"6.7万次",time:"31:02",emoji:"📡",desc:"时域频域来回看，公式不再是天书。"},
{id:"v5",title:"英语精读：长难句拆解三步法",author:"Mola 英语",views:"4.1万次",time:"12:33",emoji:"📖",desc:"主谓宾先行，修饰成分后贴。"},
{id:"v6",title:"C++：RAII 与智能指针",author:"Mola CS",views:"9.9万次",time:"27:15",emoji:"🔧",desc:"资源所有权讲清，unique_ptr 与 shared_ptr 对照。"},
];
const SAMPLE="https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4";
function render(list){
  const g=document.getElementById("grid"); if(!g) return;
  g.innerHTML=list.map(v=>`<div class="card" onclick="location.href='watch.html?id=${v.id}'"><div class="thumb">${v.emoji}</div><h3>${v.title}</h3><p>${v.author} · ${v.views} · ${v.time}</p></div>`).join("");
}
function search(){
  const q=(document.getElementById("q")||{}).value||"";
  render(VIDEOS.filter(v=>!q||v.title.includes(q)||v.author.includes(q)));
}
if(document.getElementById("grid")) render(VIDEOS);
const id=new URLSearchParams(location.search).get("id");
if(id){
  const v=VIDEOS.find(x=>x.id===id)||VIDEOS[0];
  const t=document.getElementById("vtitle"); if(t) t.textContent=v.title;
  const d=document.getElementById("vdesc"); if(d) d.textContent=v.desc;
  const vid=document.getElementById("player"); if(vid) vid.src=SAMPLE;
  const sel=document.getElementById("jobVideo");
  if(sel) sel.innerHTML=VIDEOS.map(x=>`<option value="${x.id}" ${x.id===v.id?"selected":""}>${x.title}</option>`).join("");
}
