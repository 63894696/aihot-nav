// /papers sidebar — the "解读来源" AsideCard. Lists the external Chinese-language commentary
// channels we link out to (DAIR-AI / zhaoyang97 / km1994 / kitsumiko + Hugging Face). Same shape
// the GitHub mapping jobs in Sprint B will populate papers.commentary_source with — for now the
// card is a static catalogue so readers know where to find interpretations if we have not yet
// linked a specific paper.
//
// Outline: heading + 5 source rows (name + 1-line blurb + GitHub/HF link). No counts, no
// per-paper badges — those come after Sprint B wires the commentary_md_url column.
import { AsideCard } from "../../components/ui/Page";
import { IconExternal } from "../../components/icons";
import { COMMENTARY_SOURCES } from "./commentary-sources";

export function CommentarySourcesCard() {
  return (
    <AsideCard title="解读来源">
      <p className="text-[12.5px] leading-[1.7] text-ink-3">
        中文解读与社区榜单来自以下渠道,作为本站摘要之外的延伸阅读。
      </p>
      <ul className="mt-3 space-y-3">
        {COMMENTARY_SOURCES.map((src) => (
          <li key={src.slug}>
            <a
              href={src.url}
              target="_blank"
              rel="noopener noreferrer"
              className="group block"
            >
              <div className="flex items-center gap-1.5 text-[12.5px] font-medium text-ink-2 group-hover:text-accent">
                <span>{src.name}</span>
                <IconExternal size={11} className="text-ink-4 group-hover:text-accent" />
              </div>
              <p className="mt-0.5 text-[11.5px] leading-[1.6] text-ink-4">{src.blurb}</p>
            </a>
          </li>
        ))}
      </ul>
    </AsideCard>
  );
}
