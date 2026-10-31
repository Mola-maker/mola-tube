# MolaTube Magpie 插件

在 Magpie 里控制 MolaTube agents：创建、开始、暂停、停止、重试 agent，
查看状态与任务，或跑一个一次性任务并等到结果。

## 接入

1. 先启动 MolaTube 控制面：`node server/index.mjs`（默认 http://localhost:3000）。
2. 在 Magpie 里加载本目录为插件（`MolatubeTools` 工厂，零依赖）。
3. 配置：
   - `MOLATUBE_URL`：控制面地址，默认 `http://localhost:3000`。
   - `MOLATUBE_API_KEY`：在 MolaTube Dashboard 的“令牌”页创建的 key；
     不填则以演示用户身份访问（控制面未开启 `MOLATUBE_REQUIRE_KEY=1` 时）。

## 工具

`molatube_agent_create` / `start` / `pause` / `stop` / `retry` / `status`、
`molatube_job_list`、`molatube_run_job`（一次性任务，最多等 120 秒）。

## 反向通道

MolaTube 控制面也有一个“Magpie 通道”（Dashboard → 渠道）：任务走
`server/magpie-runner.mjs`，先按 `molatube.run_job` 的 JSON Schema 校验
tool-call 信封，再 fork 真正的 Worker。v1.0 里它就是 Magpie 执行路径；
渠道上填的 endpoint 只作远端 host 地址的配置记录，转发型远端执行是
后续工作，本版不宣称已实现。

## 边界

只做用户主动发起的学习辅助（总结、答疑、笔记、自测）。不登录、不托管、
不自动化任何第三方学习平台，不代答考试。
