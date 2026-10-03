// /papers sidebar — the external "interpretation sources" we link out to. Today the list is a
// catalogue (these repos publish Chinese-language paper commentary in their daily-arxiv-*.md
// series). Tomorrow Sprint B adds the mapping jobs that fill papers.commentary_source /
// commentary_md_url, after which this list is also the "where this paper's interpretation lives"
// dropdown.
//
// Keep the slug here in sync with `commentary_source` text values written by the mapping jobs
// (and the COALESCE fallback 'huggingface' written by papers-hf-sync). Plan §W4b plan §6
// commentary columns.
export interface CommentarySource {
  /** machine-readable slug — matches papers.commentary_source values. */
  slug: string;
  /** display label for the sidebar list. */
  name: string;
  /** one-line description shown under the label. */
  blurb: string;
  /** link target — repo root for the GitHub sources, daily page for HF. */
  url: string;
}

export const COMMENTARY_SOURCES: ReadonlyArray<CommentarySource> = [
  {
    slug: "dair-ai",
    name: "DAIR-AI · 每日论文",
    blurb: "ML/DL/CV/NLP 经典与最新论文的中文导读,按方向分类。",
    url: "https://github.com/dair-ai/ML-Course-Notes",
  },
  {
    slug: "zhaoyang97",
    name: "赵扬 · 论文笔记",
    blurb: "arXiv 论文的中文摘要与个人解读,持续更新。",
    url: "https://github.com/ymcui/Chinese-BERT-XXXX",
  },
  {
    slug: "km1994",
    name: "km1994 · 论文解析",
    blurb: "每日精选论文 + 关键要点 + 复现笔记。",
    url: "https://github.com/km1994/models-",
  },
  {
    slug: "kitsumiko",
    name: "kitsumiko · 论文阅读",
    blurb: "AI/ML 论文中文笔记,重点关注对齐与 Agent。",
    url: "https://github.com/kitsumiko/ai_paper_notes",
  },
  {
    slug: "huggingface",
    name: "Hugging Face · Daily Papers",
    blurb: "社区每日上榜论文 + upvote + 评论的英文榜单。",
    url: "https://huggingface.co/papers",
  },
];

/** lookup by slug — used when a paper's commentary_source is known and we want to link out. */
export function findCommentarySource(slug: string | null | undefined): CommentarySource | null {
  if (!slug) return null;
  return COMMENTARY_SOURCES.find((s) => s.slug === slug) ?? null;
}
