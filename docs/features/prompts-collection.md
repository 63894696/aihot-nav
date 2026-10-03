# 提示词栏目(W5-3)

> 状态:v0.1(2026-10-03,基于 3 个分叉点已锁决策)
> 用途:面向访客的「可用提示词集合」,展示互联网各处零散出现的写作 / 绘画 / 学习 / 调研 / 设计等提示词,带原网页已有的评论作为使用反馈声音。**不是** `industry/prompts/`(那是给模型用的内部 editorial prompts,不入公开页面)。
> 关联:同 W5-2 search 引擎信源共用 SearXNG(10 实例轮询),新增 prompt 类型分类;不引入新 LLM 提供商、不动 `selection.ts` 阈值。

## 决策摘要(已锁)

| 分叉点 | 决策 | 备注 |
|---|---|---|
| 1. 信源元数据 | **(C) 混合** — 已知优质社区手工配进 `industry/sources.json` + SearXNG 关键词补漏(走 `industry/search-queries.json`) | PromptHero / flowgpt / awesome-chatgpt-prompts / Reddit r/* / GitHub awesome-* 各 1–2 条;搜索 query 复用 W5-2 同一组 SearXNG 实例,只换 query 列表 |
| 2. 存储结构 | **(B) 新建 `prompt_items` 表** + 子表 `source_comments` | `article_raw` 撑不住 promptText / useCase / originalComments[] 等独立字段;items 表加 `type` 字段(向后兼容增量) |
| 3. 评论抓取 | **(A) 同步抓,带熔断 + 真人化放慢** | 8s `AbortController` 超时 + 进程内 5req/min 滑动窗口(按 URL hostname)+ 命中限流/连续失败冷却名单(10 分钟)+ Chrome 120 完整 Accept-* / Sec-* 头 + 每次请求后随机 sleep 1.5–4.5s(均匀分布)。只被 prompt 流水线调用,不污染其他 article 评论抓取。失败 `fetchStatus='failed'`,不抛、不阻塞主路径 |
| 调用上限 | **不设** — LLM 评分门槛仍是 W5-2 的 `SEARCH_SCORE_THRESHOLD=70`,新走 `selection-score-prompt.md` 单独 prompt 版本 | 后续若 worker 预算报警再补阈值 |

## 数据库

迁移文件:`database/migrations/0042_prompts.sql`(在 0041 末尾之后追加,符合 AGENTS.md 「新迁移按编号加在末尾」)。

```sql
-- prompt_items: 每条提示词一条
CREATE TABLE prompt_items (
  id              BIGSERIAL PRIMARY KEY,
  item_id         BIGINT REFERENCES items(id) ON DELETE CASCADE,   -- 与 items 表的常规资料一对一(可选;无 link 时可空)
  original_url    TEXT NOT NULL,
  original_post_id TEXT,                                          -- 远端 ID(HN objectID / Reddit id / GitHub Discussions issue# 等)
  community       TEXT NOT NULL,                                  -- 手工配信源的 name,或搜索结果里取出的域名
  category        TEXT NOT NULL,                                  -- 写作/绘画/学习/调研/设计 等,见 industry/taxonomy.ts ITEM_TYPES.prompt
  prompt_text     TEXT NOT NULL,                                  -- 提示词正文
  use_case        TEXT,                                           -- 一句话说明适用场景(可从原网页摘)
  language        TEXT NOT NULL DEFAULT 'en',                     -- 提示词主语言(后续 UI 可加切换)
  source_kind     TEXT NOT NULL,                                  -- 'manual' | 'searxng_search'
  captured_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (original_url)                                            -- 同一 URL 不重复入库
);

CREATE INDEX prompt_items_category_idx     ON prompt_items (category, captured_at DESC);
CREATE INDEX prompt_items_captured_at_idx  ON prompt_items (captured_at DESC);

-- source_comments: 原网页下面已经有的评论(非站内 UGC)
CREATE TABLE source_comments (
  id            BIGSERIAL PRIMARY KEY,
  prompt_item_id BIGINT NOT NULL REFERENCES prompt_items(id) ON DELETE CASCADE,
  author_name   TEXT,
  body          TEXT NOT NULL,
  posted_at     TIMESTAMPTZ,
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fetch_status  TEXT NOT NULL DEFAULT 'ok'   -- 'ok' | 'failed' | 'timeout'
);

CREATE INDEX source_comments_prompt_item_idx ON source_comments (prompt_item_id, posted_at DESC);

-- items 表: 增加 type 字段(nullable,向后兼容)
ALTER TABLE items ADD COLUMN type TEXT;
CREATE INDEX items_type_idx ON items (type) WHERE type IS NOT NULL;
```

**回滚**:不跑迁移 = 没改动。新表独立,旧数据 `items.type` 默认为 NULL 不影响现有查询。

## 流水线接入点

**全部复用现有流程**,只在 prompt 类型处切换 prompt 版本:

```
collect(source)
  ↓  (sources/<kind>.ts 新增 'prompt_community' / 复用 'searxng_search' + 'hn_algolia')
identityKey 去重 → articles 入库
  ↓
analyze(source.type === 'prompt')
  → 切换 promptVersion = selection-score-prompt.md
  → 复用同一组预筛 / 评分 / 写摘要 prompt({{> rules-* }} / {{> safety }} / {{> content-understanding }})
  ↓
抽取 promptText / useCase / category,写 prompt_items(在 analyze 末尾并行 INSERT)
  ↓
fetchOriginalComments(originalUrl, signal)        ← 8s 超时 + 5req/min 滑动窗口
  ↓ 失败回退:fetchStatus='failed',prompt_items 仍正常展示,评论区折叠块显示「抓取失败」
publication
  ↓
公开读取层 publication/prompts.ts                  ← 唯一公开入口
```

不动的现有代码:
- `packages/backend/src/content/collect.ts`(抓取调度)
- `packages/backend/src/editorial/analyze.ts`(分析入口,只在 prompt 类型分支加 promptVersion 切换)
- `packages/backend/src/editorial/selection.ts`(**不调**阈值)
- `industry/selection.ts`(**不调**门槛)
- `industry/prompts/selection-score.md`(**不改**已有内容,新增姐妹文件)

## 熔断策略

| 项 | 值 | 实现位置 |
|---|---|---|
| 超时 | 8s `AbortController` | `packages/backend/src/sources/comments.ts` 内 |
| 进程内限流 | 5 req/min,按 URL hostname 分桶,滑动窗口 | 同上,进程内 Map |
| 主动降频(命中限流) | 单源 hostname 5 req/min 滑动窗口 | 同上 |
| 被动冷却(连续失败) | 同一 hostname 连续 3 次失败 → 进冷却名单 10 分钟,期内所有请求直接返回 `[]`(不发包) | 同上,进程内 Map<hostname, cooldownUntil> |
| 真人化放慢(防封) | User-Agent 模仿 Chrome 120 + 完整 `Accept-*` / `Sec-*` 头;每次请求后随机 sleep 1.5–4.5s(均匀分布) | `packages/backend/src/sources/comments.ts` 请求构造处;测试用 fake-timer 不阻塞 |
| 失败行为 | `fetchOriginalComments` 返回 `[]`,`fetchStatus='failed'`,**不抛、不阻塞主路径** | 流水线调用处 try/catch |
| 重试 | 不做(实现困难可不做,符合锁定决策) | — |
| 分布式限流 / 冷却 | 不做(worker 单进程,进程内足够) | — |
| 入口隔离 | `fetchOriginalComments` 是评论抓取的**唯一入口**,只被 prompt 流水线调用,不通用于其他 article 评论抓取(不污染现有逻辑) | 调用点只在 `analyze.ts` 的 prompt 分支 |

`tests/source-comments.test.ts` 覆盖 **6 场景**:**成功 / 超时 / 限流命中 / 冷却命中 / 真人化 header 验证 / 网络错误**。本地 mock fetch,不访问任何外部服务(AGENTS.md 「测试不访问任何外部服务」)。

## 公开读取层

新增 `packages/backend/src/publication/prompts.ts`,导出:

```ts
listPrompts({ category?, cursor? }): Promise<{ items: PromptCard[]; nextCursor: string | null }>
getPromptDetail(id: bigint): Promise<{ item: PromptDetail; comments: CommentRow[] }>
readPromptMeta(row): PromptCard | null       // 镜像 readSearchMeta 风格的纯函数 gate
```

公开出口:
- 列表 API:`apps/api/app/routes/prompts.ts`(GET `/api/site/prompts?category=...&cursor=...`)
- 详情 API:`apps/api/app/routes/prompt.$id.ts`(GET `/api/site/prompts/:id`)
- 缓存头:沿用 `releaseBoundCache`,与现有 timeline 同模式

**不做**:在 API 写模型调用、加管理员编辑入口、加搜索 API。

## 前端栏目

| 文件 | 内容 |
|---|---|
| `apps/web/app/routes/prompts.tsx` | 列表 + category 过滤 + 分页;风格沿用 `all.tsx` / `topics.tsx` |
| `apps/web/app/routes/prompt.$id.tsx` | 详情:头部「提示词正文」+「原网页链接(优先)」+「原评论区(折叠展开)」 |
| `apps/web/app/components/shell/nav.ts` | 加 `prompts` 入口(标签与图标沿用 `topics` 同套) |

`<SearchBadge>`(W5-2 那个)**不复用** — prompt 详情页有自己的视觉块(原评论区折叠展开器)。

**不做**:加「复制到剪贴板」按钮(浏览器 API 跨域不可控)、加 UGC 评论框、加点赞 / 收藏。

## E2E 验证

### 本地

```bash
npm run typecheck
DATABASE_URL=postgres://127.0.0.1:5432/aihot_test node scripts/migrate.ts
DATABASE_URL=postgres://127.0.0.1:5432/aihot_test npm test
node scripts/smoke.ts --base http://localhost:3000
```

新增测试 4 个文件:
- `tests/source-comments.test.ts` — 评论抓取 4 场景(本地 mock fetch)
- `tests/publication-prompts.test.ts` — `readPromptMeta` 纯函数
- `tests/prompts-source-config.test.ts` — sources.json / search-queries.json 中 prompt 条目结构
- `tests/prompts-migration.test.ts` — 迁移可重跑、字段齐

现有 35+ 测试不退回(任何一条退化视为 blocker)。

### VPS 部署后

```bash
# 列表分页
curl 'https://agentdock.dreamproject.qzz.io/api/site/prompts?category=writing'
# 详情
curl 'https://agentdock.dreamproject.qzz.io/api/site/prompts/<id>'
# Playwright:打开详情页 + 点开评论区
```

**不做**:负载测试(单实例够用,先看真页面)、SEO 提交(`INDEXNOW_SUBMIT_ENABLED` 默认关)、RSS / MCP 暴露 prompts(后续再加)。

## 安全与 AGENTS.md 对齐

| AGENTS.md 条文 | W5-3 落地 |
|---|---|
| 「公开出口都从 publication/ 读」 | 新增 `publication/prompts.ts`,API 路由只读它 |
| 「读者打开页面不触发模型调用」 | 评论抓取走 worker analyze 阶段,前端只读 DB |
| 「付费请求经过回执和预算熔断」 | 评论抓取不走付费通道(普通 HTTP),LLM 调用仍走 `selection-score-prompt.md` 经回执 |
| 「开发和测试时安全阀关闭」 | prompt 采集新增时不主动开启 `COLLECT_ENABLED` / `MODEL_CALLS_ENABLED`,留默认关 |
| 「迁移只做向后兼容增量」 | 新表独立 + `items.type` 加 nullable 列、不加 NOT NULL |
| 「不提交 .env / 密钥 / .data/」 | 测试用 `tests/setup-noop.ts` 是本地 shim,不提交 |
| 「公开内容匿名」 | 评论展示原作者来自原网页(`author_name`),不是站内用户 |
| 「信源默认只展示摘要和原文链接」 | prompt 详情页默认折叠原评论区,需点开才看 |

## 不做的事(锁死)

- 不做 UGC 社区反馈(读者→站内评论)
- 不做 LLM 调用上限阈值(后续若 worker 预算报警再补)
- 不做 prompt 全文搜索(后续再加)
- 不在 admin 加编辑入口
- 不在 RSS / MCP / llms.txt / sitemap 暴露 prompts
- 不写「复制到剪贴板」按钮
- 不改 `selection.ts` 阈值
- 不改 `industry/prompts/selection-score.md` 已有内容,新增姐妹文件
- 不加 NOT NULL 约束 / 触发器 / 改现有索引

## 风险与回滚

| 风险 | 回退 |
|---|---|
| 迁移失败 | 新表独立,旧数据 `items.type` 默认 NULL,跑失败 = 没改动 |
| LLM 打分器选错 prompt 类型 | promptVersion 自带 hash,出错可在 admin/models.tsx 看具体哪个 prompt 文案跑了哪条数据,人工介入 |
| 评论抓取被对方封 IP | 滑动窗口 + 超时已限制,回退:只展示 prompt 本身,折叠块空着 |
| 缓存击穿 | 沿用 `releaseBoundCache`,与 timeline 同 TTL 策略 |
| 信源(社区)关了或改了 URL | `sources.json` 是手工配的,后台「信源」页直接改;SearXNG 抓的依赖搜索结果稳定性,失败即丢,不阻塞主路径 |

## WBS 任务对应

| Task | 文件 |
|---|---|
| #2 W5-3-DB | `database/migrations/0042_prompts.sql`(本设计已锁结构) |
| #3 W5-3-F1 | `industry/sources.json` + `industry/search-queries.json` + `industry/prompts/selection-score-prompt.md` |
| #4 W5-3-F2 | `packages/backend/src/sources/comments.ts` + `tests/source-comments.test.ts` |
| #5 W5-3-F3 | `packages/backend/src/publication/prompts.ts` + `apps/api/app/routes/prompts.ts` + `apps/api/app/routes/prompt.$id.ts` + `tests/publication-prompts.test.ts` |
| #6 W5-3-F4 | `apps/web/app/routes/prompts.tsx` + `apps/web/app/routes/prompt.$id.tsx` + `nav.ts` |
| #7 W5-3-V1 | 本节「E2E 验证」 |
