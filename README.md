# MolaTube · 自选式学习视频站 v1.0

用户自己选、自己看的 YouTube 式学习站，配一个网页可控的高并发 Agent Harness。
Agent 只做用户主动发起的辅助（总结、答疑、笔记、自测），
不自动刷课、不代答考试、不碰任何第三方学习平台的账号与考试。

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

## 明确不做的事

- 不登录、不托管、不自动化任何第三方学习平台（包括学习通）。
- 不自动播放、不代做作业、不代答考试、不绕过签到、人脸、切屏等核验。
- 不跨用户读取工作区，不把任何凭证、会话写入日志。

## 路线图

- v1.0（本版）：完整产品——前端四页 + 渠道/令牌/配额/统计 + Magpie 双向接入。
- v1.1：接 molamaker_site_v2 的 CSS/动画/插图风格，替换现有主题；接真实视频源与真实 LLM 执行步骤。
