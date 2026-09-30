// The "/new" page is a flat window on tool_release items — a "top 30 of the last 24h" board.
// We don't group by day (the whole window is "today") and we keep the existing FeedItem card so
// the visual stays consistent with the rest of the site (timeline, topics, search results).
import type { FeedItemSummary } from "@aihot/contracts/site";
import { markRead, useReadSet } from "../../lib/local-state";
import { FeedItem } from "./FeedItem";
import { TimelineSlot } from "./Timeline";

export function NewList({ items }: { items: FeedItemSummary[] }) {
  const readSet = useReadSet();
  return (
    <ol>
      {items.map((it, i) => (
        <TimelineSlot key={it.id} at={it.timelineAt} delay={Math.min(i, 12) * 25}>
          <FeedItem item={it} read={readSet.has(it.id)} onOpen={markRead} showTags />
        </TimelineSlot>
      ))}
    </ol>
  );
}