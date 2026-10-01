// The /tools grid: one card per publication (the /api/site/tools row shape, FeedItemSummary).
// Reuses FeedItem for visual consistency with /new and /all, but lays cards in a 2-column grid on
// desktop rather than the timeline rail. Mobile: single column, full width.
import type { FeedItemSummary } from "@aihot/contracts/site";
import { markRead, useReadSet } from "../../lib/local-state";
import { FeedItem } from "./FeedItem";

export function ToolGrid({ items }: { items: FeedItemSummary[] }) {
  const readSet = useReadSet();
  return (
    <ol className="grid grid-cols-1 gap-4 lg:grid-cols-2 lg:gap-5">
      {items.map((it, i) => (
        <li key={it.id} className="animate-fade-up" style={{ animationDelay: `${Math.min(i, 12) * 25}ms` }}>
          <FeedItem item={it} read={readSet.has(it.id)} onOpen={markRead} showTags linkPrefix={"/tools" as `/tools/${string}`} />
        </li>
      ))}
    </ol>
  );
}