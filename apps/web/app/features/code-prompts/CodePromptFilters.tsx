// Kind filter chips for /code-prompts — three buckets (Agent / Instruction / Skill) plus "全部".
// Mirrors the chip-row shape of /prompts's PromptFilters (no window chip — asset_kind is the only
// filter facet for this collection).
import { Link, useSearchParams } from "react-router";
import { COPILOT_ASSET_KINDS, COPILOT_ASSET_KIND_LABELS, type CopilotAssetKind } from "@aihot/contracts/awesome-copilot";

const KINDS: Array<{ value: CopilotAssetKind | null; label: string }> = [
  { value: null, label: "全部" },
  ...COPILOT_ASSET_KINDS.map((k) => ({ value: k, label: COPILOT_ASSET_KIND_LABELS[k] })),
];

export interface CodePromptFiltersProps {
  active: { kind: CopilotAssetKind | null };
}

export function CodePromptFilters({ active }: CodePromptFiltersProps) {
  const [params] = useSearchParams();
  const currentKind = active.kind;

  function withParams(overrides: Record<string, string | null>): string {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(overrides)) {
      if (v === null || v === "") next.delete(k);
      else next.set(k, v);
    }
    return `?${next.toString()}`;
  }

  return (
    <div className="mb-5 flex flex-wrap items-center gap-1.5">
      {KINDS.map((k) => {
        const activeChip = currentKind === k.value;
        const to = k.value === null ? "/code-prompts" : `/code-prompts${withParams({ kind: k.value })}`;
        return (
          <Link
            key={k.value ?? "all"}
            to={to}
            prefetch="intent"
            className={`rounded-full px-3 py-1 text-[12.5px] transition-colors ${
              activeChip ? "bg-ink text-bg" : "bg-bg-muted text-ink-3 hover:bg-bg-sunk"
            }`}
          >
            {k.label}
          </Link>
        );
      })}
    </div>
  );
}