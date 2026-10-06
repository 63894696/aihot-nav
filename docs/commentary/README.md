# docs/commentary — 论文解读 创作 workflow

**状态**: W5-3 FIX-X v0.1 (2026-10-06 起,P0 落地)

这是单篇论文的 *解读(commentary)* 文案协作工作流。沿用 unbug.github.io
[论文解读](https://unbug.github.io/) 的 7-level 写作骨架,但执行路径在本地 ——
生成 → 人工/LLM 协作 → 评审 → 入库 → 上线,每一步都有显式的 DB 状态。

> **范围**: 这一目录只放 *human-authored commentary*。抽象 + 关键点 由 worker
> (arxiv-translate) 自动产出,本目录不重复。要点是给读者一篇能读的解读,而不仅是
> 一段翻译。

---

## 1. 管线 5 步

```
arxiv-translate (status='translated')
        │
        │  commentary_status='pending' (migration 0051 默认)
        ▼
scripts/local-commentary-gen.ts        ← 选 paper + 生成 paper_card.yaml
        │
        │  Claude 把 paper_card.yaml 贴到 chatgpt.com/new / perplexity.ai
        │  讨论用哪种 mode(micropaper / paradigm-radar / innovation-brief / skip)
        │  把 LLM 回复手工贴到 <arxiv_id>.md
        ▼
docs/commentary/<arxiv_id>.md           ← draft(本地、git-tracked、审计)
        │
        ▼
scripts/local-commentary-publish.ts    ← 校验 + flip commentary_status='published'
        │
        ▼
publication read layer 读 commentary_md_url + commentary_source
        │
        ▼
apps/web /papers/:id 详情页 "解读" 区块 3 态渲染(下一 commit 接)
```

每一步可单独重跑,blast radius 隔离:

| 步骤 | 写什么 | 失败后果 |
|---|---|---|
| gen | `docs/commentary/<id>.yaml` + 空 `.md` | 不会污染 DB,只生成本地文件 |
| 人工/LLM 协作 | `.md` | 不会污染 DB,只在本地 |
| publish | `papers.commentary_status` 等 4 列 | DB 改动,可 git revert + SQL 兜回 |

---

## 2. 三种 commentary mode

来自 unbug.github.io 论文解读 创作技巧。Claude 在纸卡生成后,把卡片贴到 LLM,
讨论该 paper 适合哪种 mode。

### micropaper — 单篇精读(800-1500 字,默认)

适合:绝大部分 translated 论文。

7-level 骨架(每层 1-3 句):

1. **标题** — paper 的实际主张(不要论文原标题翻译)
2. **核心问题** — 它要解决的具体痛点
3. **论文解法** — 它提出的方法/框架/实验
4. **证据锚点** — 实验结果/数据/案例(每条挂 `[F]` `[A]` `[I]` `[U]` 标记)
5. **翻译层** — 给非专业读者的概念解释(类比、生活化例子)
6. **边界层** — 这篇没回答什么 / 不适用什么场景
7. **意义层** — 对工程实践 / 后续研究 / 产品方向的启发

evidence discipline:never correlation→causation; never benchmark→production;
every claim traceable。

### paradigm-radar — 趋势解读(≥ 2 个独立信号)

适合:同时有 ≥ 2 篇 paper 指向同一趋势,或 paper + 工程实践 + 产品公告指向同一
方向。本站的 tool_papers join 现在还没接,这一 mode **人工判断** 启用 ——
auto-mode 默认不选 paradigm-radar。

### innovation-brief — 机会解读(paper + 专利 + 产品)

适合:paper 描述的方法已经被申请专利 / 已有产品化。本站没接专利 / 产品数据源,
这一 mode **人工判断** 启用 — auto-mode 默认不选 innovation-brief。

---

## 3. CLI 用法

### 3.1 生成 draft 骨架

```bash
# 单篇(已知 arxiv_id)
node --env-file=.env scripts/local-commentary-gen.ts \
  --arxiv-id=2601.12345 --mode=micropaper

# 批量(取 top N commentary_status='pending' 的 paper)
node --env-file=.env scripts/local-commentary-gen.ts --batch=5

# dry-run(只看哪些 paper 还没生成 draft,不写文件)
node --env-file=.env scripts/local-commentary-gen.ts --batch=10 --dry-run
```

生成结果:

- `docs/commentary/<arxiv_id>.yaml` — paper_card.yaml(给 LLM 看的输入物)
- `docs/commentary/<arxiv_id>.md` — 空 draft 模板,等 LLM 回复后填

### 3.2 人工 / LLM 协作

把 `<arxiv_id>.yaml` 的内容贴到:

- chatgpt.com/new(用户已登录),开头:"以下是 paper 的 paper_card.yaml,帮我按
  micropaper 7-level 骨架写一篇 800-1500 字的解读,evidence discipline 沿用
  [F]/[A]/[I]/[U] 标记。"
- 或 comet.perplexity.ai(用户已登录),同 prompt

把回复手工贴到 `<arxiv_id>.md`。

> **凭证**:MEMORY 2026-10-05/06 chatgpt cookies / Tavily / OpenRouter key 泄露事件后,
> 任何 key/cookie **不入对话文本**。本 CLI 不出网,凭据留在浏览器 session 里。

### 3.3 校验 + 入库

```bash
# 校验通过 → flip commentary_status='published'
node --env-file=.env scripts/local-commentary-publish.ts \
  --arxiv-id=2601.12345 --source=chatgpt

# source 取值: chatgpt | perplexity | human | hybrid
# 校验会检查: ≥ 400 chars + 至少一个 [F]/[A]/[I]/[U] marker

# 跳过 paper(创作技巧也写不出好文案)
node --env-file=.env scripts/local-commentary-publish.ts \
  --arxiv-id=2601.12345 --skip --skipped-reason='与 micropaper 不匹配:paper 太短 (abstract 87 chars)'
```

`--skipped-reason` 是审计线索 —— 留档避免下次 cycle 重复 prompt。

### 3.4 git commit

```bash
git add docs/commentary/<arxiv_id>.{md,yaml}
git commit -m "commentary(<arxiv_id>): micropaper draft via chatgpt"
```

`papers.commentary_status='published'` 是在 `local-commentary-publish.ts` 里 flip 的,
git commit 是文案层 audit trail,两者独立。

---

## 4. 校验规则(脚本 enforce)

`local-commentary-publish.ts` 拒绝任何:

- `< 400 chars` 的 draft(unbug micropaper 最小 ~800,这里给 400 是底线)
- 缺 `[F]/[A]/[I]/[U]` 任意 evidence marker 的 draft
- `--skip` 但缺 `--skipped-reason` 的尝试
- `--source` 不在 `{chatgpt, perplexity, human, hybrid}` 的尝试

校验失败 exit code 2 + stderr 给出具体原因,DB 不动。

---

## 5. DB 状态机

```
                     translated
                          │
                          │  translation 完成 → 0051 backfill 默认 commentary_status='pending'
                          ▼
                       pending
                       │    │
                       │    │  local-commentary-gen.ts 拉这队列 → paper_card.yaml
                       │    │
       local-commentary-publish.ts
                       │    │
                       │    └────► skipped  (写 skipped_reason)
                       │
                       └────────► published  (写 commentary_md_url + commentary_source)
```

`commentary_status=NULL` 留给还没翻译的 paper(arxiv-translate 的状态机管辖)。

---

## 6. 前端渲染(下一 commit)

`apps/web/app/routes/papers.$id.tsx` 详情页加 commentary 区块,三态:

- **published**:`<h2>解读</h2>` + 渲染 `commentary_md_url` markdown 内容 +
  副标题 `来源: ChatGPT / Perplexity / 人工 / 人机协作`
- **skipped**:`<h2>解读</h2>` + 一行 `<reason>`(灰字)
- **pending**:`<h2>解读</h2>` + "尚无解读"

publication 层(`packages/backend/src/publication/papers.ts`)扩 `PaperDetail` 加
3 个字段:`commentary_status` / `commentary_md_url` / `commentary_source`。

(本 README 写在 P0 阶段,前端渲染在 P1 落地 — 见 FIX-X V2。)
