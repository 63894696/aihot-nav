// / — the navigation layer's root. Currently 301-redirects to /new (每日新品, the homepage for "AI 工具导航 + 每日新品").
// When /tools ships in W2 the redirect may move to /tools and /new becomes a sub-page; for now /new IS the homepage.
//
// Why 301 not 302: the previous shape (精选 timeline at /) has no surviving inbound traffic worth preserving
// as soft. A permanent redirect tells crawlers and aggregators the new canonical is /new.
import { redirect } from "react-router";
import type { Route } from "./+types/home";

export async function loader(_args: Route.LoaderArgs) {
  throw redirect("/new", 301);
}

export function meta(_args: Route.MetaArgs) {
  return [{ title: "AI 工具每日新品 · AIHUB" }, { name: "robots", content: "noindex" }];
}