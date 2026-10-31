# 推广帖草稿（仅起草，未发布）

> 注意：以下帖文只是草稿。是否发布、从哪个账号发布，由用户确认后才执行。
> Trending 由 star 增速驱动，关键词与话题只管“被发现”，不能保证上榜。

## 中文版（X  thread，3 条）

1/ 我做了 MolaTube：一个用户自己选、自己看的学习视频站，
配一个网页可控的高并发 Agent Harness。
视频由你自己挑、自己看；Agent 只在你点下任务后才动手——
总结、答疑、笔记、自测。不刷课、不代答考试。

2/ 里面最硬的两块：
- Worker 池：常驻进程复用，插件只导入一次，50 任务压测 10.5 任务/秒
- 真实浏览器：原生 CDP pipe 驱动 headless-shell，每 Agent 独立
  BrowserContext，池化 + 回收 + 内存看门狗，截图默认视口 JPEG q75
零 npm 依赖，Node >= 24 一行 `npm start` 就跑。

3/ 开源在 GitHub：github.com/Mola-maker/mola-tube
欢迎 star / 提 issue / 加插件。
#AgentHarness #MultiAgent #BrowserAutomation #CDP #NodeJS #OpenSource

## English version (X thread, 3 posts)

1/ I built MolaTube: a self-directed learning video site with a
web-controlled, high-concurrency agent harness.
You pick and watch the videos yourself; agents only act when you ask —
summaries, Q&A, notes, self-quizzes. No auto-play for credit, no exam answers.

2/ The two hardest parts:
- Worker pool: long-lived workers, plugins loaded once — 50 jobs at 10.5 jobs/s
- Real browser: raw CDP over --remote-debugging-pipe, one BrowserContext
  per agent, pooling + recycling + RSS watchdog, viewport JPEG q75 screenshots
Zero npm dependencies. `npm start` and it runs.

3/ Open source: github.com/Mola-maker/mola-tube
Stars, issues and plugins welcome.
#AgentHarness #MultiAgent #BrowserAutomation #CDP #NodeJS #OpenSource
