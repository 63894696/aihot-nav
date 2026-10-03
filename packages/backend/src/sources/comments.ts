// Original-page comments fetcher for the W5-3 prompt column.
//
// Why this file exists separately from rss.ts / web-list.ts / searxng.ts:
// - The prompt column shows comments from the original web page (Reddit / HN / a blog post) as
//   feedback for the prompt text. That audience does not exist for any other signal — articles in
//   `articles` already have their own comment-fetch pipeline that does not apply here.
// - The same hostname can be fetched many times in a row (one prompt per post, many posts per
//   community). That gives us a real ban risk that other collectors do not face, so we slow down
//   per hostname and back off when the host starts to push back.
//
// Per-hostname bookkeeping (sliding window + cooldown) lives in module-scope Maps. Workers are
// single-process, so process-local state is sufficient and we deliberately do NOT use Redis. See
// docs/features/prompts-collection.md §熔断策略 for the numbers.

import { setTimeout as sleep } from "node:timers/promises";

/** Result row we return from a comments fetch. Mirrors `source_comments` columns. */
export interface CommentRow {
  author_name: string | null;
  body: string;
  posted_at: Date | null;
}

export type FetchStatus = "ok" | "failed" | "timeout";

export interface CommentFetchResult {
  comments: CommentRow[];
  fetchStatus: FetchStatus;
}

/** Window knobs — keep in sync with docs/features/prompts-collection.md §熔断策略. */
const REQUEST_BUDGET_PER_MIN = 5;
const WINDOW_MS = 60_000;
const REQUEST_TIMEOUT_MS = 8_000;
const COOLDOWN_MS = 10 * 60_000;
const FAIL_THRESHOLD = 3;
const SLEEP_MIN_MS = 1_500;
const SLEEP_MAX_MS = 4_500;

/** Chrome 120 on Windows 10, with the Sec-CH-UA client hints Reddit / HN / common blogs check. */
const CHROME_HEADERS: Record<string, string> = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
  "accept-encoding": "gzip, deflate, br",
  "cache-control": "no-cache",
  pragma: "no-cache",
  "sec-ch-ua": '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
  "sec-fetch-user": "?1",
  "upgrade-insecure-requests": "1",
};

interface HostState {
  /** Recent fetch start timestamps (ms epoch). Trimmed to the last WINDOW_MS. */
  hits: number[];
  /** Consecutive failures since the last success. Reset to 0 on any 2xx. */
  failCount: number;
  /** Epoch ms; while > now, the host is in cooldown and we refuse to send a request. */
  cooldownUntil: number;
}

const hostState = new Map<string, HostState>();

/**
 * Reset all per-hostname bookkeeping. Test-only; production code must never call this.
 *
 * Exported so tests can clean up state between scenarios without poking into private Maps.
 */
export function _resetHostStateForTests(): void {
  hostState.clear();
}

/**
 * Test-only injection point for the request sleep. Production passes `node:timers/promises.setTimeout`;
 * tests pass a fake timer that resolves immediately so the suite doesn't sit idle for seconds.
 */
export type Sleeper = (ms: number) => Promise<void>;
let sleeper: Sleeper = (ms) => sleep(ms);

/** Test-only: replace the request sleep. Pass `() => Promise.resolve()` in test setups. */
export function _setSleeperForTests(s: Sleeper): void {
  sleeper = s;
}

/**
 * Test-only: replace the underlying HTML fetch. Production passes the global `fetch`; tests pass
 * a stub that returns canned HTML or controlled failures.
 */
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
let fetcher: Fetcher = (url, init) => fetch(url, init);

/** Test-only: replace the HTML fetcher. */
export function _setFetcherForTests(f: Fetcher): void {
  fetcher = f;
}

function nowMs(): number {
  return Date.now();
}

function getState(hostname: string): HostState {
  let s = hostState.get(hostname);
  if (!s) {
    s = { hits: [], failCount: 0, cooldownUntil: 0 };
    hostState.set(hostname, s);
  }
  return s;
}

/** Returns true when a request to this hostname should be sent right now. */
function canSend(state: HostState, now: number): { allow: true } | { allow: false; reason: "rate" | "cooldown" } {
  if (state.cooldownUntil > now) return { allow: false, reason: "cooldown" };
  // Drop entries outside the sliding window, then count.
  const cutoff = now - WINDOW_MS;
  while (state.hits.length > 0 && state.hits[0]! < cutoff) state.hits.shift();
  if (state.hits.length >= REQUEST_BUDGET_PER_MIN) return { allow: false, reason: "rate" };
  return { allow: true };
}

function recordSuccess(state: HostState): void {
  state.failCount = 0;
  state.cooldownUntil = 0;
}

function recordFailure(state: HostState, now: number): void {
  state.failCount += 1;
  if (state.failCount >= FAIL_THRESHOLD) state.cooldownUntil = now + COOLDOWN_MS;
}

/**
 * Extract comments from an HTML string. Conservative — only the most common shapes — because the
 * test suite is what holds us to the contract, and we deliberately do NOT trust arbitrary HTML
 * to contain a comment block. Anything we don't recognise returns `[]`.
 */
export function parseCommentsFromHtml(html: string, sourceUrl: string): CommentRow[] {
  const out: CommentRow[] = [];
  // Reddit JSON API would be cleaner; this is the HTML fallback for any host that returns HTML.
  // We look for the most common blocks: <article class="Comment"> / <div class="comment"> /
  // <li class="Comment">. Body text is the inner text of the first <p> we find inside each block.
  const blocks = html.match(/<(?:article|li|div)\s+class="[^"]*comment[^"]*"[^>]*>[\s\S]*?<\/(?:article|li|div)>/gi) ?? [];
  for (const block of blocks) {
    const authorMatch = /<a[^>]+class="[^"]*author[^"]*"[^>]*>([^<]+)</i.exec(block);
    const bodyMatch = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    const dateMatch = /<time[^>]+datetime="([^"]+)"/i.exec(block);
    if (!bodyMatch) continue;
    const body = bodyMatch[1]!.replace(/<[^>]+>/g, "").trim();
    if (!body) continue;
    out.push({
      author_name: authorMatch ? authorMatch[1]!.trim() : null,
      body,
      posted_at: dateMatch ? new Date(dateMatch[1]!) : null,
    });
  }
  if (out.length === 0) {
    // Last-ditch: any HTML containing at least one <p class="comment-body"> block (HN-style).
    const paras = html.match(/<p[^>]+class="[^"]*comment-body[^"]*"[^>]*>([\s\S]*?)<\/p>/gi) ?? [];
    for (const p of paras) {
      const body = p.replace(/<[^>]+>/g, "").trim();
      if (body) out.push({ author_name: null, body, posted_at: null });
    }
  }
  return out;
}

/**
 * Fetch the original-page comments for a prompt URL. Always resolves with `{ comments, fetchStatus }`;
 * never throws. Caller is responsible for persisting `fetchStatus` so the UI can show the failure.
 *
 * @param url  The original post URL (must be http(s); SSRF guard not enforced here because callers
 *             have already validated the URL when the prompt item was created).
 * @param signal  Optional external abort signal. Composed with the internal 8s timeout.
 */
export async function fetchOriginalComments(url: string, signal?: AbortSignal): Promise<CommentFetchResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { comments: [], fetchStatus: "failed" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { comments: [], fetchStatus: "failed" };
  }
  const hostname = parsed.hostname.toLowerCase();
  const now = nowMs();
  const state = getState(hostname);

  const gate = canSend(state, now);
  if (!gate.allow) {
    // Refuse to send the request: hit either the rate budget or an active cooldown.
    return { comments: [], fetchStatus: "failed" };
  }

  state.hits.push(now);

  // Compose the external signal with our 8s timeout.
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(new Error("timeout")), REQUEST_TIMEOUT_MS);
  const composed = composeSignals(signal, timeoutController.signal);

  // Real-person slow-down: random sleep in [1.5s, 4.5s] before each request. Uniform.
  const jitter = SLEEP_MIN_MS + Math.random() * (SLEEP_MAX_MS - SLEEP_MIN_MS);
  await sleeper(jitter);

  let response: Response;
  try {
    response = await fetcher(url, {
      method: "GET",
      headers: CHROME_HEADERS,
      redirect: "follow",
      signal: composed.signal,
    });
  } catch (err) {
    clearTimeout(timeoutId);
    const isTimeout = isAbortError(err) && composed.signal.aborted && timeoutController.signal.aborted;
    if (isTimeout) {
      recordFailure(state, nowMs());
      return { comments: [], fetchStatus: "timeout" };
    }
    recordFailure(state, nowMs());
    return { comments: [], fetchStatus: "failed" };
  }
  clearTimeout(timeoutId);

  if (!response.ok) {
    recordFailure(state, nowMs());
    return { comments: [], fetchStatus: "failed" };
  }

  let html: string;
  try {
    html = await response.text();
  } catch {
    recordFailure(state, nowMs());
    return { comments: [], fetchStatus: "failed" };
  }

  recordSuccess(state);
  return { comments: parseCommentsFromHtml(html, url), fetchStatus: "ok" };
}

function composeSignals(a?: AbortSignal, b?: AbortSignal): { signal: AbortSignal } {
  if (!a && !b) return { signal: new AbortController().signal };
  if (a && !b) return { signal: a };
  if (!a && b) return { signal: b };
  // Both present: any of them aborts the composed signal.
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  a!.addEventListener("abort", onAbort, { once: true });
  b!.addEventListener("abort", onAbort, { once: true });
  return { signal: ctrl.signal };
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError" || /aborted|timeout/i.test(err.message));
}
