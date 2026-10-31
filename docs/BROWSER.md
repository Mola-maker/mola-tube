# 真实浏览器：设计与选型（v1.2）

## 最终选型（深度调研结论，2026-11-01）

原生 CDP + `--remote-debugging-pipe` + `chrome-headless-shell` +
每 Agent 一个 `Target.createBrowserContext` + 多浏览器进程池化，
Node 零 npm 依赖。唯一备选是 `playwright-core` + `--only-shell`
（仅当需要 Firefox/WebKit、无力维护 CDP、或需要自动等待/定位器时）；
Selenium（含 BiDi）与 browser-use / Stagehand / Nanobrowser / Crawlee
已排除：前者协议层系统性吃亏，后者与 LLM 决策循环或爬虫队列耦合，
与本项目的确定性工具调用冲突。

诚实保留：未找到可信的 WS-vs-pipe 毫秒级基准——pipe 的收益是结构
简化（省 TCP 回环、端口发现与暴露面）与生命周期绑定，不是魔法加速；
导航/读取/截图的主导成本本来就是网络、渲染与页面 JS。内存与冷启动
数字均为第三方区间，需以本机压测收敛（本机实测见下）。

## 架构

```
控制面 (server/index.mjs)
  ├─ 浏览器 API: /api/browser/*（开/关/读/导航/截图/标签列表/上下文关闭）
  ├─ 浏览器插件 (server/plugins/browser/index.mjs)：6 个工具，走同一守护进程
  └─ 浏览器守护进程 (server/browser-daemon.mjs，独立进程)
       ├─ 浏览器池：懒创建，上限 BROWSER_POOL_SIZE（默认 1）
       ├─ 每浏览器：pipe CDP（fd3 写 / fd4 读，NUL 分隔 JSON，单帧 32MB 上限）
       ├─ 每 (user, agent)：一个 BrowserContext；默认 Context 永不给 Agent
       ├─ 看门狗（20 秒）：采样浏览器进程树 RSS（/proc 聚合，PSS 口径近似）
       └─ localhost 中继：沙箱经认证出口代理上网时，Chrome 经本地中继
          注入 Proxy-Authorization（只绑 127.0.0.1）；无代理环境不启用
```

## 关键行为（均已实测）

- 开/关/导航/读取/截图：example.com 真实加载（标题 Example Domain、
  真实正文、JPEG 截图），非模拟。
- 隔离：同一用户的不同 agent 互相看不到、关不掉对方的标签页
  （`browser-stress.mjs` 隔离断言通过）；agent 停止时关闭其整个 Context。
- 上限：每用户标签上限（默认 8）、每 agent 标签上限（默认 3）、
  每浏览器标签软上限（默认 20）；超限返回明确错误，不静默排队。
- 回收：浏览器无标签页时，看门狗按年龄（默认 60 分钟）、累计 Context
  数（默认 200）、RSS（默认 2048MB）回收重建；实测以
  `BROWSER_RECYCLE_CONTEXTS=2` 验证：b0 回收后下一次开页得到 b1。
- 截图：视口 JPEG q75、scale=1（`Emulation.setDeviceMetricsOverride`
  固定 1280×800）；禁止默认全页 PNG（体积与 base64 传输三重浪费）。
- 读取：页内 `innerText` 截断 4000 字符回传，不回传整页 HTML。
- 安全：只允许公开 http(s)；localhost、`.local`、私网 IP、解析到私网
  地址的域名一律拒绝（SSRF  guard，含 DNS 复查缓存 60 秒）。
  不输入凭证、不登录、不碰学习平台；截图与产物只写任务工作区。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `MOLATUBE_BROWSER` | 1（非 0 即开） | 关掉则不启动守护进程，浏览器功能报不可用 |
| `BROWSER_MAX_TABS` | 8 | 每用户标签上限 |
| `BROWSER_MAX_TABS_PER_AGENT` | 3 | 每 agent 标签上限 |
| `BROWSER_POOL_SIZE` | 1 | 浏览器池上限；小服务器 1 即够 |
| `BROWSER_TABS_PER_BROWSER` | 20 | 触发新浏览器的单浏览器标签软上限 |
| `BROWSER_RECYCLE_MINUTES` | 60 | 无标签页时的年龄回收线 |
| `BROWSER_RECYCLE_CONTEXTS` | 200 | 无标签页时的累计 Context 回收线 |
| `BROWSER_MAX_RSS_MB` | 2048 | 浏览器进程树 RSS 回收线 |
| `BROWSER_VIEWPORT_W/H` | 1280/800 | 截图与布局视口 |
| `CHROME_BIN` | 自动探测 | 优先 Playwright 的 chrome-headless-shell |

## 本机实测（2026-11-01，沙箱 2 CPU / 7.8GB）

- 浏览器并发：3 agent 并行开 / 读 / 截图 / 关，3/3 通过，3.0 秒；
  隔离断言通过，收尾 0 残留标签页（`scripts/browser-stress.mjs`）。
- 回收：`BROWSER_RECYCLE_CONTEXTS=2` 下，3 个 Context 关闭后看门狗
  回收 b0，下一次开页得到 b1；RSS 采样实测 394MB（空闲）/ 689MB（3 页）。
- 任务压测 v2：见 `docs/stress-report-v2.json`（50/50、10.5 任务/秒）。
