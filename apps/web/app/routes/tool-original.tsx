import type { Route } from "./+types/tool-original";
import type { SiteToolDetail } from "@aihot/contracts/site";
import { loadOr404 } from "../lib/api.server";

export { default, headers, meta } from "./tool.$id";

export async function loader({ params, request }: Route.LoaderArgs) {
  const tool = await loadOr404<SiteToolDetail>(`/api/site/tool/${encodeURIComponent(params.id)}/original`, { signal: request.signal });
  return { tool };
}