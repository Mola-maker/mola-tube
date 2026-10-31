# MolaTube · 自选式学习视频站

用户自己选、自己看的 YouTube 式学习站。Agent 只做用户主动发起的辅助，
不自动刷课、不代答考试、不碰任何第三方学习平台的账号与考试。

## 产品定位

- 浏览页：像 YouTube 一样刷视频、搜课程、收藏、建播放列表，全由用户自己点。
- 观看页：用户自己播放，进度只记录用户真实的观看行为，不做任何自动播放取分。
- Agent 工作台：用户选一个视频、主动提交一个任务（总结、答疑、笔记、自测题），
  能看到排队、进行中、完成、取消全过程，也能随时停掉自己的任务。

## 首版包含什么

- `web/`：纯静态前端，首页 / 观看页 / Agent 工作台 / Agents 控制页，可直接用浏览器打开。
- `server/`：零依赖 Node Harness，持久化队列 + 子进程 Worker 隔离 + SSE 实时控制 + 每任务独立工作区。
- `docs/ARCHITECTURE.md` 与 `docs/ARCHITECTURE-v2.md`：高并发、独立工作区、安全隔离的设计文档。
- `docs/REFERENCES.md`：参考调查（DeepSeek Harness、dsh-superagent-prototype、LayerFS），以及采纳与不采纳的理由。

## 快速试用

```bash
# 只看前端演示（工作台走本地演示模式）
open web/index.html

# 连上本地 Harness（可选）
node server/index.mjs   # 监听 http://localhost:3000
```

## 明确不做的事

- 不登录、不托管、不自动化任何第三方学习平台（包括学习通）。
- 不自动播放、不代做作业、不代答考试、不绕过签到、人脸、切屏等核验。
- 不跨用户读取工作区，不把任何凭证、会话写入日志。

## 路线图

- v0.1：静态前端 + 本地 Harness 骨架 + 架构文档。
- v0.2（本版）：高并发网页控 Agents 架构——持久化队列、子进程 Worker、SSE、Agent 生命周期（开始/暂停/停止/重试/备注）。
- v0.3：接 molamaker_site_v2 的 CSS/动画/插图风格，替换现有主题；接真实视频源。
- v0.3：多用户账号、newapi 式多渠道支付抽象（只用于会员与增值功能，不卖刷课结果）。
