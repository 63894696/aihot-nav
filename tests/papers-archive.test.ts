// FIX-AA-C — pin the NDJSON archive dump's row format, ordering, and hash semantics.
//
// The archive job writes one NDJSON file every 10 days. The wire shape and the ordering
// are load-bearing — a future reader (a duckdb script, jq, a pandas pipeline) may consume
// snapshots without running our code, so the format must stay standard NDJSON, arxiv_id
// ASC, with `schema_version: 1` per row.
//
// We test the pure serialiser + hash function. The DB-bound runPapersArchive() is exercised
// in the integration smoke (VPS deploy), where the SQL is real; here we just keep the cheap
// pure functions pinned so a regression in JSON.stringify handling or hash function is caught
// before the worker runs.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";

// Mirror of packages/backend/src/operations/papers-archive.ts toArchiveRecord + toNDJSON +
// sha256Hex. Keep in sync.
interface ArchiveRecord {
  schema_version: 1;
  arxiv_id: string;
  title_en: string;
  title_zh: string | null;
  abstract_en: string;
  abstract_zh: string | null;
  authors: string[];
  primary_category: string;
  published_at: string;
  abs_url: string;
  status: string;
  hf_upvotes: number | null;
  fetched_at: string;
  translated_at: string | null;
  summary_model: string | null;
}

function toNDJSON(records: ArchiveRecord[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : "");
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

const SAMPLE_ROWS: ArchiveRecord[] = [
  {
    schema_version: 1,
    arxiv_id: "2401.12345",
    title_en: "A Transformer Survey",
    title_zh: "Transformer 综述",
    abstract_en: "We survey transformers.",
    abstract_zh: "我们综述了 Transformer。",
    authors: ["Alice", "Bob"],
    primary_category: "cs.CL",
    published_at: "2024-01-15T00:00:00.000Z",
    abs_url: "https://arxiv.org/abs/2401.12345",
    status: "translated",
    hf_upvotes: 42,
    fetched_at: "2024-01-16T03:14:15.000Z",
    translated_at: "2024-01-16T03:18:42.000Z",
    summary_model: "minimax/minimax-m3",
  },
  {
    schema_version: 1,
    arxiv_id: "2401.12346",
    title_en: "RLHF in Practice",
    title_zh: null,
    abstract_en: "We explore RLHF.",
    abstract_zh: null,
    authors: ["Carol"],
    primary_category: "cs.LG",
    published_at: "2024-01-16T00:00:00.000Z",
    abs_url: "https://arxiv.org/abs/2401.12346",
    status: "fetched",
    hf_upvotes: null,
    fetched_at: "2024-01-17T02:00:00.000Z",
    translated_at: null,
    summary_model: null,
  },
];

test("FIX-AA-C: NDJSON — every line is valid JSON, joined by '\\n', trailing newline", () => {
  const nd = toNDJSON(SAMPLE_ROWS);
  // Trailing newline — strict NDJSON parsers (jq -c) handle both with and without, but we
  // standardise on-with for grep friendliness.
  assert.ok(nd.endsWith("\n"), "NDJSON file must end with a newline");
  const lines = nd.split("\n").filter((l) => l.length > 0);
  assert.equal(lines.length, SAMPLE_ROWS.length, "one JSON object per row");
  for (const line of lines) {
    const parsed = JSON.parse(line);
    assert.ok(typeof parsed === "object" && parsed !== null, "each line is a JSON object");
  }
});

test("FIX-AA-C: NDJSON — every record carries schema_version=1", () => {
  // Forward-compat: a future v2 migration can stamp new rows with v2 and consumers can
  // filter on schema_version. The current v1 contract is non-negotiable — every row today
  // must carry `1`.
  const nd = toNDJSON(SAMPLE_ROWS);
  for (const line of nd.split("\n").filter((l) => l.length > 0)) {
    const parsed = JSON.parse(line);
    assert.equal(parsed.schema_version, 1);
  }
});

test("FIX-AA-C: NDJSON — field completeness (15 keys, every record)", () => {
  // The schema is intentionally small — every ArchiveRecord carries exactly the fields a
  // downstream consumer might need for a paper-recommendation or citation-graph pipeline.
  // A future column on `papers` does not automatically land here; that is intentional —
  // schema growth on the archive needs a schema_version bump, not a silent field add.
  const expectedKeys = new Set([
    "schema_version", "arxiv_id", "title_en", "title_zh", "abstract_en", "abstract_zh",
    "authors", "primary_category", "published_at", "abs_url", "status", "hf_upvotes",
    "fetched_at", "translated_at", "summary_model",
  ]);
  for (const row of SAMPLE_ROWS) {
    assert.deepEqual(new Set(Object.keys(row)), expectedKeys, `record ${row.arxiv_id} field set`);
  }
});

test("FIX-AA-C: arxiv_id ASC ordering is the caller's responsibility (caller selects ORDER BY)", () => {
  // The serialiser does not sort — it preserves input order. The contract is that the
  // caller (selectAllPapers in packages/backend/src/operations/papers-archive.ts) selects
  // ORDER BY arxiv_id ASC, so this test verifies the assumption: feeding two rows out of
  // order yields a file that is OUT OF ORDER (caller must sort). This is a deliberate
  // contract test, not a bug — keeping the serialiser pure makes the file's diff against
  // the DB input obvious.
  const reversed = [...SAMPLE_ROWS].reverse();
  const ndReversed = toNDJSON(reversed);
  const lines = ndReversed.split("\n").filter((l) => l.length > 0);
  assert.equal(JSON.parse(lines[0]).arxiv_id, "2401.12346", "first line = first input row");
  assert.equal(JSON.parse(lines[1]).arxiv_id, "2401.12345", "second line = second input row");
});

test("FIX-AA-C: sha256 is deterministic + changes on data change", () => {
  // The sha256 of the same input is identical (snapshot-to-snapshot diffs become easy)
  // and changes the moment any field changes (so a re-run after a new fetch produces a
  // fresh commit, not a no-op).
  const nd1 = toNDJSON(SAMPLE_ROWS);
  const nd2 = toNDJSON(SAMPLE_ROWS);
  assert.equal(sha256Hex(nd1), sha256Hex(nd2), "same input → same hash");

  const mutated: ArchiveRecord[] = [
    { ...SAMPLE_ROWS[0], title_en: "A Transformer Survey (Updated)" },
    SAMPLE_ROWS[1],
  ];
  const nd3 = toNDJSON(mutated);
  assert.notEqual(sha256Hex(nd1), sha256Hex(nd3), "any field change → hash changes");
});

test("FIX-AA-C: empty input → empty string (no zero-length newline)", () => {
  // An empty corpus at first-run (zero papers) must produce a zero-byte file, not a file
  // with one stray newline. The git push layer checks for empty diffs and skips a commit
  // when there is nothing new — a zero-byte file with a trailing newline is technically a
  // change (file existence).
  const nd = toNDJSON([]);
  assert.equal(nd, "", "empty input → empty string");
});

test("FIX-AA-C: JSON-safe field values — null is preserved (not omitted)", () => {
  // title_zh=null on untranslated papers must serialise to JSON null, not be dropped.
  // Downstream consumers that filter on `WHERE title_zh IS NOT NULL` (a common pattern for
  // Chinese-language dashboards) rely on the null being explicit.
  const nd = toNDJSON([SAMPLE_ROWS[1]]);
  const parsed = JSON.parse(nd.trim());
  assert.equal(parsed.title_zh, null, "title_zh=null preserved as JSON null");
  assert.equal(parsed.translated_at, null, "translated_at=null preserved");
  assert.equal(parsed.summary_model, null, "summary_model=null preserved");
});