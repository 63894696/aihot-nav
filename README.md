# aihot-nav

> AI 工具导航 · 每日新品 · Changelog · 论文 · 提示词 — 五件事一个站

[![MIT License](https://img.shields.io/badge/license-MIT-176b75?style=flat-square)](LICENSE)
[![Node.js 24](https://img.shields.io/badge/Node.js-24-176b75?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![PostgreSQL 17](https://img.shields.io/badge/PostgreSQL-17-176b75?style=flat-square&logo=postgresql&logoColor=white)](https://www.postgresql.org)
[![Docker Compose](https://img.shields.io/badge/Docker-Compose-176b75?style=flat-square&logo=docker&logoColor=white)](https://docs.docker.com/compose/)

**aihot-nav** 是 [aihot](https://github.com/KKKKhazix/AIHOT) 框架的二次元 fork。基于 aihot 上游的多源采集 + 模型筛选 + 事件聚簇 + 日报 pipeline,把产品方向从"AI 行业动态聚合"重新定位为**AI 圈重度用户每天的第一站**。

---

## 这是什么

aihot-nav 不是另一个 AI 新闻聚合站。它做的是五件事:

| # | 频道 | 角色 | 形态 |
|---|---|---|---|
| 1 | **每日新品** | 搬运工(压缩时间) | 24h 内 top 30 新工具 |
| 2 | **工具导航** | 搬运工 | 累积工具目录 + 过滤侧栏 |
| 3 | **工具详情** | 搬运工 + 指引者 | 单工具页 + 最近 7 天更新 + 相关工具 |
| 4 | **Changelog 聚合** | 搬运工 | 按工具 group 的时间线 |
| 5 | **论文 / 预印本解读** | 翻译官(帮助知) | arXiv 摘要 + 中文翻译 + 关键要点 |
| 6 | **提示词精选** | 指引者(帮助行) | 场景标签 + 一键复制 |

**三角色合一**:内容搬运工(压缩信息获取时间)+ 翻译官(帮助理解)+ 能力使用指引者(帮助行动)= 服务拉满。

**双层内容哲学**:**导航型打底**(工具属性是骨架,必须先 ship)+ **内容型粘性**(信息差是肌肉,基于导航层实体 / 标签才能精准推荐)。

---

## 与上游 aihot 的关系

- **License**:MIT(沿上游,见 [LICENSE](LICENSE))
- **上游仓库**:[KKKKhazix/AIHOT](https://github.com/KKKKhazix/AIHOT)
- **差异**:产品方向从"AI 行业动态"调整为"AI 工具导航 + 每日新品 + 内容型增值服务"
- **不沿用**:`AIHOT` 站名 / Logo / 域名(AGENTS.md 第 36 行明令禁止 fork 使用)
- **沿用**:后端 ingestion pipeline / 9 类 itemType 分类思想 / 五轴评分 / selected_state 精选 / pg-boss worker / Fastify SSR / 行业包(`industry/`)可热替换设计

---

## 跑起来

```bash
# 1. 拷环境变量模板
cp .env.example .env
# 编辑 .env,填入你的 DATABASE_PASSWORD / 模型 API key / 搜索 API key

# 2. 起服务(docker compose 自动跑 migrate + seed)
docker compose up -d --build

# 3. 访问
# http://localhost:3000  — 站点
# http://localhost:3000/admin  — 后台(默认禁用,需 .env 启用)
```

> ⚠️ **不要把 `.env` 提交到 Git**。`.gitignore` 已默认屏蔽,只提交 `.env.example`(只占位符)。

---

## 它是怎么工作的

```
信源(18 source demo + 自加)
  ↓ RSS / API
articles 抓取表
  ↓ 模型预筛 + 五轴评分 + 精选
selected_state 精选表 + publications 渲染表
  ↓
publications.type 过滤(tool_release / tool_update / model_release / research_paper / tool_or_prompt)
  ↓
/api/site/* 公开出口
  ↓
apps/web React Router v7 SSR → daily / tools / tools/:id / changelog / papers / prompts
```

详细架构见 [`docs/`](docs/)。后端信息处理设计借鉴 aihot 上游,**不照抄 schema**。

---

## 改成你的行业 / 你的产品

按 [`docs/customize.md`](docs/customize.md) 顺序改 `industry/`:

| 文件 | 内容 |
|---|---|
| `site.ts` | 站名、行业词、首页文案、关于页、备案号 |
| `taxonomy.ts` | 分类、标签、公司与机构、防错词表 |
| `topics.json` | 主题目录(`/topics`)|
| `sources.json` | 示范信源(18 个公开海外 AI 资讯源,MVP 够跑通) |
| `prompts/` | 每一步提示词:预筛 / 评分 / 写作 / 结构化 / 归组 / 综述 / 日报 / 翻译 |
| `selection.ts` | 入选门槛(用你标注的样本重新校准,**不要凭感觉改数字**) |
| `features.ts` | 模块开关 |
| `brand/` | 图标、Logo、报头字 |
| `pages/` | 使用规则、隐私说明(模板,上线前按实际情况改写) |
| `changelog.json` | 更新日志 |

通常不需要改 `apps/` 和 `packages/`。

---

## 安全规则(读 AGENTS.md 第 27-37 行)

- 前端(`apps/web`)只通过 HTTP 读 `apps/api`,数据库、模型调用和密钥只在后端
- 所有公开出口都从 `packages/backend/src/publication/` 这一个读取层读
- 读者打开页面**不触发模型调用**;模型只在 worker 任务里调用
- 付费请求都经过回执(`providers/receipts.ts`)和预算熔断
- 开发和测试时保持安全阀关闭:`COLLECT_ENABLED`、`MODEL_CALLS_ENABLED`、`FEISHU_*_ENABLED`、`INDEXNOW_SUBMIT_ENABLED`
- 信源默认只展示摘要和原文链接(`site_fulltext` 关);只有来源明确允许时才打开全文
- 公开内容**匿名**,管理员和访客看到的一样;后台只允许管理员
- 数据库迁移只做向后兼容的增量,新迁移按编号加在 `database/migrations/` 末尾
- **不要提交 `.env`、密钥和 `.data/`**
- **不要使用 AIHOT 的名字和 Logo**

---

## 致谢

- [KKKKhazix/AIHOT](https://github.com/KKKKhazix/AIHOT) — 上游 framework,MIT
- [数字生命卡兹克](https://github.com/KKKKhazix) — aihot 设计者,MIT 版权方
- [theresanaiforthat.com](https://theresanaiforthat.com) — UI 借鉴(TAAFT 卡片网格 + 工具详情布局)
- [Product Hunt](https://www.producthunt.com) / [Hacker News Show HN](https://news.ycombinator.com/show) / [GitHub Trending](https://github.com/trending) — 导航层新工具信源(W2 接入)

---

## License

MIT — 见 [LICENSE](LICENSE)
