# MolaTube v0.2：高并发网页控 Agents 架构

> 参考见 `docs/REFERENCES.md`。本架构只做用户主动发起的任务，
> 不登录、不托管、不自动化任何第三方学习平台，不代答考试。

## 1. 分层

```
浏览器（首页 / 观看页 / 工作台 / Agents 控制页）
  → 控制面 API（鉴权、限流、审计、SSE 推送）
    → Engine（单写者：状态变更只走同步 transition，落盘后再广播）
      → 持久化：server/data/state.json（快照）+ events.jsonl（append-only 事件）
      → 队列 JobQueue（FIFO + 跳过式公平：被上限挡住的 job 不堵住后面的）
      → 执行面：子进程 Worker（每 job 一个 node 子进程，IPC 回报进度）
        → 工作区 server/workspaces/<jobId>/（输入快照、步骤产物、结果）
```

控制面与执行面分离：HTTP 进程崩了，Worker 会被一起回收；
Worker 崩了，只影响它自己的 job（标 failed），不拖垮控制面与其他任务。

## 2. 实体与状态

- **Agent**：被网页长期 supervised 的执行体。状态：`idle`（空闲）/ `working`（有 job 在跑）/
  `waiting`（上一个 job 中断/失败，等人重试）/ `paused`（暂停，不再起新 job）/ `stopped`（已停）。
- **Job**：一次执行。状态：`queued` / `running` / `done` / `cancelled` / `timeout` / `failed` / `interrupted`。
- **状态诚实规则**：重启后，`running` 的 job 一律标 `interrupted`，其 agent 标 `waiting`，
  绝不假装它跑完了；重试由人显式点，不自动重跑。

## 3. 并发与背压（三级上限，环境变量可调）

| 上限 | 默认 | 说明 |
| --- | --- | --- |
| `MAX_RUNNING` | 3 | 全局同时跑的 Worker 数 |
| `PER_USER_RUNNING` | 2 | 每用户同时跑的 Worker 数 |
| 每 agent 同时跑 | 1 | 一个 agent 一次只跑一个 job |
| `QUEUE_MAX` | 100 | 排队 job 上限，满了返回 429 并明说“排队已满” |

- Pump：每次状态变化后扫描队列，按序启动能启动的 job；被上限挡住的跳过，不 head-of-line 阻塞。
- 幂等：同一 agent 同一视频同一任务类型已有 queued/running 的 job 时，直接返回它，不重复建。
- 取消：人随时取消，控制面先 SIGTERM，2 秒未退再 SIGKILL，job 标 `cancelled`，随后 Pump 补位。
- 超时：`JOB_TIMEOUT_MS`（默认 120 秒）到时强杀，标 `timeout`。
- 暂停语义（说清楚，不玩文字游戏）：pause = **跑完当前 job 后不再起新 job**，
  不是把进行中的步骤冻住；空闲 agent 点暂停立即生效。

## 4. 工作区与安全

- 每 job 一个目录，Worker 只能写自己目录（路径监狱：解析后必须落在该目录内，否则拒绝）。
- Worker 子进程环境经过滤：不继承控制面的敏感环境变量；`--max-old-space-size=256` 封顶内存。
- 凭证规则：v0.2 不接任何第三方账号；未来接 provider 时，密钥只放进当次 job 的工作区临时文件，
  不进日志、不进快照、不跨 job 复用。
- 外部文本（视频标题、简介、评论）只当数据引用，绝不当中控指令；工具调用只走任务白名单。
- 出站只允许配置的白名单域名（v0.2 的模拟步骤不产生出站，接入真实步骤时在 worker 层 enforcement）。
- 审计：每次 transition 记一行事件（时间、实体、动作），不记正文以外的隐私。

## 5. 实时控制面

- `GET /api/events`：SSE，主通道。每次 transition 广播一次，15 秒心跳；前端 SSE 断了自动 2 秒轮询兜底。
- 人的控制（与 dsh-superagent 的 Panel 思路一致，但只保留 MolaTube 需要的）：
  `start`（起 job）/ `pause` / `resume` / `stop` / `retry`（失败或中断后重跑）/ `note`（给 agent 留备注，写入工作区与审计）。
- 面板三问（照抄它的信息优先级）：有什么需要我？系统健康吗？一件活的历史是怎样的？
  Agents 页先放“等人的 agent”（waiting / failed），再放系统负载（running / queued / caps），
  历史只在点开 agent 后展示，不在总览里铺开。

## 6. 兼容与升级路径

- v0.1 的 `/api/jobs`（创建/列表/取消）与 `/api/audit` 保持兼容，旧工作台不用改。
- 工作区目录结构不变，未来把目录换成 LayerFS Workspace 时只改 Worker 的读写层，不改控制面。
- 横向扩展预留：把 `state.json` 换成 SQLite/Postgres、把子进程换成容器时，
  Engine 的 transition 接口与事件格式不变；本版不提前引入这些依赖。
