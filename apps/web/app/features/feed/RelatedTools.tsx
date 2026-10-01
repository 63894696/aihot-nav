// /tools/:id "相关工具" rail. Top-scoring siblings whose tag overlap with the current item is at
// least 2 (plan §4 R6 — tag-based rather than entity-based because the canonical tools schema is
// deferred to W3+). Each row links to /tools/:id so readers stay inside the catalog.
import { Link } from "react-router";
import type { FeedItemSummary } from "@aihot/contracts/site";
import { ScoreLabel } from "../../components/ui/Score";

export function RelatedTools({ items }: { items: FeedItemSummary[] }) {
  if (items.length === 0) return null;
  return (
    <section>
      <h2 className="text-[12px] font-semibold text-ink-3">相关工具</h2>
      <ul className="mt-2.5 divide-y divide-line-soft">
        {items.map((it) => (
          <li key={it.id} className="flex items-start gap-2 py-2 first:pt-0 last:pb-0">
            <Link to={`/tools/${it.id}`} className="min-w-0 flex-1 text-[13.5px] leading-snug text-ink-2 hover:text-accent">
              {it.title}
            </Link>
            <ScoreLabel score={it.score} compact />
          </li>
        ))}
      </ul>
    </section>
  );
}