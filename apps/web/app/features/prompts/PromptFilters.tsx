// Category chips + window filter for /prompts (W5-3). Mirrors /papers's filter row shape so the
// two columns feel consistent. The category chip group uses the 10-bucket taxonomy from the
// publication layer (writing / coding / image / video / audio / agent / data / research / study /
// other) — capability-axis so a prompt card and a tool card can share the same key on the detail
// page. The window chips reuse the 7/30/90 day pattern.

import { Link, useSearchParams } from "react-router";
import { PROMPT_CATEGORIES, PROMPT_CATEGORY_LABELS } from "@aihot/contracts/site";

const CATEGORIES = [
  { value: null, label: "全部" },
  ...PROMPT_CATEGORIES.map((k) => ({ value: k, label: PROMPT_CATEGORY_LABELS[k] })),
] as const;

const WINDOWS = [
  { value: 7, label: "7 天" },
  { value: 30, label: "30 天" },
  { value: 90, label: "90 天" },
] as const;

export interface PromptFiltersProps {
  active: { category: string | null; windowDays: number };
}

export function PromptFilters({ active }: PromptFiltersProps) {
  const [params] = useSearchParams();
  const currentCategory = active.category;
  const currentWindow = active.windowDays;

  function withParams(overrides: Record<string, string | number | null>): string {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(overrides)) {
      if (v === null || v === "") next.delete(k);
      else next.set(k, String(v));
    }
    return `?${next.toString()}`;
  }

  return (
    <div className="mb-5 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex flex-wrap items-center gap-1.5">
        {CATEGORIES.map((c) => {
          const activeChip = currentCategory === c.value;
          const to = c.value === null ? "/prompts" : `/prompts${withParams({ category: c.value })}`;
          return (
            <Link
              key={c.value ?? "all"}
              to={to}
              prefetch="intent"
              className={`rounded-full px-3 py-1 text-[12.5px] transition-colors ${
                activeChip ? "bg-ink text-bg" : "bg-bg-muted text-ink-3 hover:bg-bg-sunk"
              }`}
            >
              {c.label}
            </Link>
          );
        })}
      </div>

      <div className="flex items-center gap-1.5">
        <span className="text-[12px] text-ink-4">时间窗</span>
        {WINDOWS.map((w) => {
          const activeChip = currentWindow === w.value;
          const to = w.value === 90 ? "/prompts" : `/prompts${withParams({ windowDays: w.value })}`;
          return (
            <Link
              key={w.value}
              to={to}
              prefetch="intent"
              className={`rounded-full px-3 py-1 text-[12.5px] transition-colors ${
                activeChip ? "bg-ink text-bg" : "bg-bg-muted text-ink-3 hover:bg-bg-sunk"
              }`}
            >
              {w.label}
            </Link>
          );
        })}
      </div>
    </div>
  );
}