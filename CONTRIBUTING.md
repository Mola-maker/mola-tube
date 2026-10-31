# 参与 MolaTube

## 跑起来

```bash
npm start
# 打开 http://localhost:3000/
```

需要 Node >= 24，零 npm 依赖，不用安装任何东西。

## 加一个插件

插件是一个目录，导出一个工厂函数，返回 `{ tool: { <name>: { description, args, execute } } }`
（magpie 形态）或 `{ tools, call }`（自带形态）；`execute(args, ctx)` 里
`ctx = { agent, user, workspace, directory }`。本地调试：

```bash
MOLATUBE_PLUGIN_DIRS=/path/to/your-plugin npm start
```

插件任务走隔离子进程（30 秒超时），工作区路径有监狱校验——不要绕过它。

## 提 PR 前

- `node --check` 过所有改动的 JS 文件；
- 有行为变化的改动请附实测证据（命令 + 结果），不要只写“应该可以”；
- 不要提交 `server/data/` 与 `server/workspaces/`（已被 .gitignore 排除）；
- 范围规则不变：不登录、不托管、不自动化任何第三方学习平台，
  不自动播放取分、不代答考试。

## 报告问题

请写清：复现步骤、期望结果、实际结果（含报错原文）、Node 版本与操作系统。
