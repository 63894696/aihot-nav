// /tools/:id "最近 7 天的更新" rail. A small list of sibling tool/model/platform publications
// discovered in the last week that overlap the current item's tags. Each row links to the existing
// /items/:id detail; we keep /tools and /items cross-linked so a reader can move between the catalog
// and the per-publication reading view without changing URLs.
import { Link } from "react-router";
import type { FeedItemSummary } from "@aihot/contracts/site";
import { fullDateTime } from "../../lib/format";

export function ToolUpdates({ items }: { items: FeedItemSummary[] }) {
  if (items.length === 0) return null;
  return (
    <section>
      <h2 className="text-[12px] font-semibold text-ink-3">最近 7 天的更新</h2>
      <ul className="mt-2.5 space-y-2.5">
        {items.map((it) => (
          <li key={it.id} className="border-l-2 border-line-soft pl-2.5 text-[13px] leading-snug">
            <Link to={`/items/${it.id}`} className="line-clamp-2 text-ink-2 hover:text-accent">
              {it.title}
            </Link>
            <div className="mt-0.5 text-[11.5px] text-ink-4">
              <span>{it.source.name}</span>
              <span className="mx-1.5">·</span>
              <time dateTime={it.timelineAt}>{fullDateTime(it.timelineAt)}</time>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}