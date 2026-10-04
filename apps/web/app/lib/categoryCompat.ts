// W5-3 v0.2.1 — categoryCompat
//
// Front-end re-export of the legacy category-key resolver. Route loaders
// (`/tools`, `/all`, `/daily`, `/leaderboard`) call `resolveCategoryKey` on the
// `category` query param; if it lands on a legacy v0.2.0 key, they return a 301
// redirect to the mapped new key. The mapping table itself lives in the
// contracts package so the API, RSS and sitemap consumers share one source of
// truth.

import {
  isLegacyCategoryKey,
  LEGACY_CATEGORY_REDIRECT,
  resolveCategoryKey,
} from "@aihot/contracts/taxonomy";

export { isLegacyCategoryKey, LEGACY_CATEGORY_REDIRECT, resolveCategoryKey };

/**
 * Build a 301 redirect target for a legacy key. Returns `null` when the
 * incoming key is already a current category key (or unknown) — caller can
 * keep serving without a redirect.
 *
 * Usage in a route loader:
 *   const raw = new URL(request.url).searchParams.get("category");
 *   const target = legacyCategoryRedirect(raw, "/all");
 *   if (target) throw redirect(target);
 */
export function legacyCategoryRedirect(raw: string | null, basePath: string): string | null {
  if (!raw) return null;
  const target = LEGACY_CATEGORY_REDIRECT[raw];
  if (!target || target === raw) return null;
  return `${basePath}?category=${encodeURIComponent(target)}`;
}
