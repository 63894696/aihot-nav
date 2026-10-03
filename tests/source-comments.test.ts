// W5-3 source-comments.ts: 6 test scenarios covering the prompt-column comments fetcher.
// We do NOT hit the network — every test stubs the global fetch and the post-request sleep so the
// suite stays in-process and the 1.5–4.5s real-person slow-down doesn't sit on the runner's clock.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  fetchOriginalComments,
  _setFetcherForTests,
  _setSleeperForTests,
  _resetHostStateForTests,
} from "@aihot/backend/sources/comments";

const noopSleeper = async () => {};
const sleepFast = async (ms: number) => {
  // Snap any requested sleep to a single tick so the suite doesn't wait.
  await new Promise<void>((resolve) => setImmediate(resolve));
  void ms;
};

const HTML_WITH_COMMENTS = `<html><body>
  <div class="Comment">
    <a class="author">alice</a>
    <p>first body one</p>
    <time datetime="2026-09-20T08:00:00Z"></time>
  </div>
  <div class="Comment">
    <a class="author">bob</a>
    <p>second body two</p>
    <time datetime="2026-09-21T09:00:00Z"></time>
  </div>
</body></html>`;

beforeEach(() => {
  _resetHostStateForTests();
  _setSleeperForTests(noopSleeper);
});

afterEach(() => {
  _setSleeperForTests(noopSleeper);
  _setFetcherForTests((url, init) => fetch(url, init));
  _resetHostStateForTests();
});

test("fetchOriginalComments: happy path returns parsed comments + status=ok", async () => {
  _setFetcherForTests(async () => new Response(HTML_WITH_COMMENTS, { status: 200, headers: { "content-type": "text/html" } }));
  const out = await fetchOriginalComments("https://example.com/post/1");
  assert.equal(out.fetchStatus, "ok");
  assert.equal(out.comments.length, 2);
  assert.equal(out.comments[0]!.author_name, "alice");
  assert.equal(out.comments[0]!.body, "first body one");
  assert.equal(out.comments[0]!.posted_at?.toISOString(), "2026-09-20T08:00:00.000Z");
  assert.equal(out.comments[1]!.author_name, "bob");
});

test("fetchOriginalComments: timeout when fetch does not settle in 8s returns status=timeout", async () => {
  // Use the real sleeper for this scenario (the time-budget is what we are testing), but resolve
  // the sleep instantly so we don't actually wait 1.5s for the pre-request slow-down.
  _setSleeperForTests(sleepFast);
  _setFetcherForTests(async (_url, init) => {
    return new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(new Error("aborted")));
    });
  });
  const out = await fetchOriginalComments("https://slow.example.com/p/1");
  assert.equal(out.fetchStatus, "timeout");
  assert.deepEqual(out.comments, []);
});

test("fetchOriginalComments: rate-limit (5 req/min) blocks the 6th request without sending", async () => {
  let sent = 0;
  _setFetcherForTests(async () => {
    sent += 1;
    return new Response(HTML_WITH_COMMENTS, { status: 200, headers: { "content-type": "text/html" } });
  });
  // Six calls on the same hostname within a minute — the first five succeed, the sixth is refused.
  const results = [];
  for (let i = 0; i < 6; i++) {
    results.push(await fetchOriginalComments("https://rl.example.com/p/" + i));
  }
  const statuses = results.map((r) => r.fetchStatus);
  assert.deepEqual(statuses, ["ok", "ok", "ok", "ok", "ok", "failed"]);
  assert.equal(sent, 5, "the 6th call must not have hit the network");
});

test("fetchOriginalComments: 3 consecutive failures on a hostname put it in cooldown for 10 min", async () => {
  let sent = 0;
  _setFetcherForTests(async () => {
    sent += 1;
    return new Response("boom", { status: 500 });
  });
  const out1 = await fetchOriginalComments("https://cooldown.example.com/p/1");
  const out2 = await fetchOriginalComments("https://cooldown.example.com/p/2");
  const out3 = await fetchOriginalComments("https://cooldown.example.com/p/3");
  assert.equal(out1.fetchStatus, "failed");
  assert.equal(out2.fetchStatus, "failed");
  assert.equal(out3.fetchStatus, "failed");
  assert.equal(sent, 3, "the first 3 attempts go out");
  // 4th attempt is now in cooldown — must NOT hit the network.
  const out4 = await fetchOriginalComments("https://cooldown.example.com/p/4");
  assert.equal(out4.fetchStatus, "failed");
  assert.equal(sent, 3, "the 4th attempt is refused by cooldown, no packet sent");
});

test("fetchOriginalComments: Chrome 120 + Sec-CH-UA + Accept-* headers sent on the wire", async () => {
  let sentHeaders: Record<string, string> = {};
  _setFetcherForTests(async (_url, init) => {
    sentHeaders = init.headers as Record<string, string>;
    return new Response(HTML_WITH_COMMENTS, { status: 200, headers: { "content-type": "text/html" } });
  });
  const out = await fetchOriginalComments("https://headers.example.com/p/1");
  assert.equal(out.fetchStatus, "ok");
  assert.match(sentHeaders["user-agent"] ?? "", /Chrome\/120\.0\.0\.0/);
  assert.match(sentHeaders["accept"] ?? "", /^text\/html/);
  assert.match(sentHeaders["accept-language"] ?? "", /^zh-CN/);
  assert.match(sentHeaders["sec-ch-ua"] ?? "", /Chromium.*120/);
  assert.equal(sentHeaders["sec-ch-ua-mobile"], "?0");
  assert.equal(sentHeaders["sec-fetch-mode"], "navigate");
});

test("fetchOriginalComments: network error returns status=failed (does NOT throw)", async () => {
  _setFetcherForTests(async () => {
    throw new Error("ECONNREFUSED");
  });
  const out = await fetchOriginalComments("https://neterr.example.com/p/1");
  assert.equal(out.fetchStatus, "failed");
  assert.deepEqual(out.comments, []);
});
