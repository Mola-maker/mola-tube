# MolaTube 插件系统（v1.1）

插件是真实代码、真实效果，不是步骤文案。任务执行与直接调用都走插件，
一次失败只影响当次调用，不拖垮控制面。

## 插件形态

一个插件 = 一个目录 + `index.mjs`，导出工厂函数（默认导出，或以 `Tools`
结尾的命名导出，例如 magpie-layerfs 的 `LayerfsTools`），工厂返回以下任一：

- `{ tool: { 名字: { description, args, execute } } }`（magpie 形态）
- `{ tools: [...], call: (name, args) => ... }`（MolaTube 插件形态）
- `{ 名字: { description, args, execute } }`（普通工具对象）

`execute(args, ctx)` 的 ctx 为 `{ agent, workspace, directory }`：
`workspace` 是当次任务的工作区目录，工具只能在该目录内读写（路径监狱）；
`directory` 是服务端数据目录（magpie-layerfs 用它拒绝把配置目录当 source）。

## 自带插件

- `video`：`video_catalog` / `video_inspect` / `video_search`。
  对 `server/videos.default.json`（可被 `server/data/videos.json` 覆盖）做
  真实计算：时长换算、简介长度、关键词频次。
- `workspace`：`workspace_write` / `workspace_read` / `workspace_list` /
  `workspace_snapshot`。快照哈希全部文件并报告逻辑字节与去重后字节，
  去重比是算出来的，不是宣称的。

## 外部真实插件

`MOLATUBE_PLUGIN_DIRS`（冒号分隔）指向外部插件目录，启动时加载。
例如接入真实的 magpie-layerfs：

```bash
MOLATUBE_PLUGIN_DIRS=/home/hatch/workspace/magpie-layerfs node server/index.mjs
```

它的 sim 后端默认写 `~/.magpie-layerfs`；MolaTube 启动 Worker 时会把
`MAGPIE_LAYERFS_HOME` 与 `MAGPIE_LAYERFS_PAGE_DIR` 指到服务端数据目录下，
不污染插件原目录。`GET /api/plugins` 列出全部插件与工具，
`POST /api/plugins/:plugin/:tool/call` 在隔离子进程里跑一次调用
（30 秒超时，抛错只失败当次调用）。

## 任务如何用插件

- `summary` / `notes` / `quiz` / `qa`：Worker 先调 `video_inspect` 拿真实
  视频信息，再调 `workspace_write` 写产物（`summary.md` / `notes.md` /
  `quiz.md` / `answer.md`），最后 `workspace_snapshot` 快照。
  QA 与自测题是模板生成，产物里明说“未调用大模型”，不伪装成模型输出。
- `plugin` 类型任务：`{ type: "plugin", plugin, tool, args }`，Worker 直接
  执行该插件工具，把结果写进 `result.json` 并快照。
- 控制面不替插件背书：插件抛错 → 任务标 `failed`，控制面继续服务。

## 并发与隔离

- 每个任务一个 Worker 子进程；插件直接调用一个调用一个子进程
  （`plugin-runner.mjs`）。插件崩溃、超时、死循环只影响当次任务。
- 通道并发上限：渠道的 `concurrency` 字段（0 = 不限，走全局上限），
  排队扫描时按通道分别计数，超了的通道跳过、不堵住其他通道的任务。
- 优雅停机：SIGTERM/SIGINT 后不再起新任务，最多等 10 秒让运行中的
  任务结束，剩下的强杀并落盘；重启后它们标 `interrupted`，需手动重试。
