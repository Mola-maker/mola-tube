<img src="assets/icon.webp" alt="MolaTube 图标" width="120">

# MolaTube · 自选式学习视频站 v1.2

**30 秒了解：MolaTube 是什么？** 一个用户自己选、自己看的 YouTube 式学习视频站，
配一个网页可控的高并发 Agent Harness。**适合谁？** 想按自己的节奏学视频、
又想让 Agent 帮忙整理学习成果的人——视频由你自己挑、自己看，Agent 只在你点
下任务后才动手。**怎么跑？** 一步就够：

```bash
npm start
# 打开 http://localhost:3000/
```

**范围规则（不变）：** 用户自己选、自己看；Agent 只做用户主动发起的辅助
（总结、答疑、笔记、自测），不自动刷课、不代答考试、不碰任何第三方学习平台
的账号与考试。

## v1.2：真实浏览器 + 极致优化（2026-11-01）

- **真实浏览器**（`server/browser-daemon.mjs`，详见 `docs/BROWSER.md`）：每 Agent
  独立 BrowserContext 的真实 Chromium 标签页（开 / 关 / 导航 / 读取 / 截图），
  前端新增“浏览器”页。传输按深度调研的最终选型走
  `--remote-debugging-pipe`（fd3/fd4，零 npm 依赖），不用 WebSocket；
  浏览器池化 + 定期回收 + 内存看门狗；截图默认视口 JPEG q75。
  只允许公开 http(s) 网址，localhost 与内网地址一律拒绝；不登录任何账号、
  不碰学习平台。
- **极致优化**：Worker 池（`server/pool.mjs` + `server/pool-worker.mjs`）——
  常驻进程复用，插件只在启动时导入一次，任务不再付 fork 与导入成本。
  压测 v2（见 `docs/stress-report-v2.json`）：50 任务 50/50 完成、0 失败、
  上限 5 守住、4.76 秒（10.5 任务/秒，v1.1 为 7.04 秒 / 7.1 任务/秒），
  压测中控制面 p95 85ms（v1.1 为 270ms）。浏览器并发实测：3 Agent 并行
  开 / 读 / 截图 / 关全过，且互相看不到、关不掉对方的标签页。
- **选型结论**（深度调研，报告见 `docs/BROWSER.md` 引用）：原生 CDP + pipe +
  chrome-headless-shell + 每 Agent BrowserContext + 浏览器池化是最终选型；
  唯一备选是 `playwright-core` + `--only-shell`（仅当需要 Firefox/WebKit、
  无力维护 CDP、或需要自动等待/定位器时）；Selenium 与 browser-use 等
  Agent 框架已排除。

## v1.1：真实插件、真实控制、真实并发（2026-11-01）

- **真实插件**（`server/plugins.mjs`，详见 `docs/PLUGINS.md`）：插件是真实代码、
  真实效果。内置 `video`（目录检索 / 检查 / 搜索，时长与关键词为真实计算）
  与 `workspace`（工作区内写 / 读 / 列出 / 快照，含真实去重比）。
  `MOLATUBE_PLUGIN_DIRS` 可接入外部真实插件，已实测接入 magpie-layerfs
  （provision / checkpoint / fork / publish / exec / history / resolve / status）。
  任务类型新增 `plugin`：直接执行指定插件工具，结果写 `result.json` 并快照。
- **真实执行**：Worker 不再是模拟步骤。总结 / 笔记 / 自测 / 答疑都先调
  `video_inspect` 拿真实视频信息，再写真实产物并快照；答疑用 agent 的最新
  备注当问题；自测与答疑产物明说“模板生成，未调用大模型”，不伪装成模型输出。
  真实大模型步骤与真实视频源是后续工作，见路线图。
- **真实控制**：Agents 的开始 / 暂停（跑完当前停）/ 停止 / 重试 / 备注、
  渠道开关与优先级、配额，均在真实执行下实测通过；失败任务 agent 标
  “等你处理”，只手动重试，不自动重跑。
- **高并发硬化**：每个任务一个 Worker 子进程，插件直接调用一个调用一个
  子进程；通道可设 `concurrency` 上限；SIGTERM/SIGINT 优雅停机（最多等
  10 秒，重启后未完成任务标 `interrupted`）。修了一个压测中发现的真 bug：
  子进程 exit 事件可能比最后一条 IPC 消息先到，控制面会把已完成的任务
  误标失败——现在 exit 后等 200ms 再定性，并要求终端消息先落盘再退出。
- **前端优化**：SSE 为主通道、未接通时才轮询；状态没变不重写 DOM；
  搜索防抖 300ms、按 `/` 聚焦搜索；提示用 toast 不再弹窗；观看进度只存在
  你的浏览器里；页眉统一用蓝发 OC 图标。
- **压力测试**（`scripts/stress-test.mjs`，报告 `docs/stress-report.json`）：
  50 个并发混合任务（总结 / 笔记 / 自测 / 答疑 / 插件任务，local 与 magpie
  双通道，50 个不同用户）：**50/50 完成，失败 0，上限 5 始终未超，
  7.04 秒跑完（7.1 任务/秒），压测中控制面延迟 p95 270ms，压测后新任务
  仍能完成**。注意：一键任务按（用户、视频、类型）对同时运行的重复提交
  去重，压测用多用户绕开该去重，见脚本注释。

## 一键启动

```bash
npm start
# 打开 http://localhost:3000/
# 首页 / 观看页 / Agent 工作台 / Agents 控制 / 控制面板（dashboard）都在同一服务上
```

前端也可直接用浏览器打开 `web/` 下的页面；连上本地服务后自动从演示模式切换。

## 产品结构

- **首页 / 观看页**：刷视频、搜课程、收藏、播放列表，全由用户自己点；
  进度只记录真实观看行为。
- **Agent 工作台**（`web/workbench.html`）：一次性任务，排队、进度、取消全过程可见。
- **Agents 控制**（`web/agents.html`）：长期 supervised 的 agent：创建、开始、
  暂停（跑完当前任务后停）、恢复、停止、重试、备注。
- **控制面板**（`web/dashboard.html`，布局参考 newapi 的总览 / 渠道 / 令牌 / 日志 / 设置，
  实现均为本仓库自写）：统计卡片与近 14 天任务图、渠道管理、令牌管理、
  日志过滤、配额设置。
- **后端渠道**（`server/channels.mjs`）：任务的执行路径，可多条并存：
  - `local`：直接 fork Worker 子进程。
  - `magpie`：先按 `molatube.run_job` 的 JSON Schema 校验 tool-call 信封
    （`server/magpie-runner.mjs`），再 fork Worker；附带审计记录。
  - 路由：启用中的通道按优先级升序、权重降序取第一条；任务可指定 `channelId`。
  - 渠道上的 endpoint 字段只作远端 host 地址的配置记录，转发型远端执行是后续工作。
- **令牌与配额**：Dashboard 可创建 API 令牌（明文只显示一次，服务端只存哈希，
  额度用完或吊销后返回 401）；请求带 `X-Api-Key` 即以令牌主人身份访问；
  不带令牌时为演示用户（以 `MOLATUBE_REQUIRE_KEY=1` 启动则强制要求令牌）。
  每用户 Agent 上限与每日任务上限可在面板设置。
- **Magpie 插件**（`magpie-plugin/`，零依赖）：在 Magpie 里控制 MolaTube，
  工具为 `molatube_agent_create/start/pause/stop/retry/status`、
  `molatube_job_list`、`molatube_run_job`；配置 `MOLATUBE_URL` 与 `MOLATUBE_API_KEY`。

## 架构要点（详见 `docs/ARCHITECTURE-v2.md`）

- 控制面与执行面分离：HTTP/SSE 只做状态与控制，干活在子进程 Worker 里。
- 状态单写者 + 磁盘快照 + append-only 事件日志；重启后中断任务诚实标
  `interrupted`、agent 标 `waiting`，重试必须手动点。
- 并发三级上限：全局 3、每用户 2、每 agent 1（环境变量可调），队列满 100 返回 429。
- 工作区隔离：每任务一个目录 + 路径监狱；Worker 内存封顶 256MB，超时强杀。

## API 一览

| 接口 | 说明 |
| --- | --- |
| `GET /api/health` / `GET /api/stats` | 负载与统计 |
| `GET/POST /api/agents`，`POST /api/agents/:id/start\|pause\|resume\|stop\|retry\|note` | Agent 生命周期 |
| `GET/POST /api/jobs`，`POST /api/jobs/:id/cancel` | 一次性任务（v0.1 兼容） |
| `GET/POST/PATCH/DELETE /api/channels`，`POST /api/channels/:id/test` | 渠道管理 |
| `GET/POST /api/keys`，`POST /api/keys/:id/revoke` | 令牌管理 |
| `GET/PATCH /api/quotas` | 配额 |
| `GET /api/events` | SSE 实时推送 |
| `GET /api/audit` | 审计记录 |
| `GET /api/plugins`，`POST /api/plugins/:plugin/:tool/call` | 插件列表与隔离调用 |

## 明确不做的事

- 不登录、不托管、不自动化任何第三方学习平台（包括学习通）。
- 不自动播放、不代做作业、不代答考试、不绕过签到、人脸、切屏等核验。
- 不跨用户读取工作区，不把任何凭证、会话写入日志。

## 路线图

- v1.0：完整产品——前端四页 + 渠道/令牌/配额/统计 + Magpie 双向接入。
- v1.1：真实插件 + 真实执行 + 真实控制 + 并发硬化 + 前端优化 + 50 并发压测通过。
- v1.2（本版）：Worker 池 + 真实浏览器（pipe 传输 + 池化 + 看门狗 + JPEG 截图）+ 压测 v2 通过。
- 后续：接 molamaker_site_v2 的 CSS/动画/插图风格，替换现有主题；接真实视频源与真实 LLM 执行步骤。
