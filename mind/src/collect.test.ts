import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  decodeXmlEntities,
  extractTag,
  stripHtmlTags,
  truncate,
  candidateId,
  parseArxivAtom,
  parseFeed,
  scoreText,
  selectTopCandidates,
  cutUnseen,
  advanceCursor,
  runCollect,
  migrateLegacyInbox,
  type CollectState,
  type PendingCandidate,
} from "./collect.js";
import { CoreHttpError, type CoreClient, type BranchSummary, type IngestRequest } from "./core-client.js";
import type { CosmosConfig } from "./config.js";

const ARXIV_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2501.00001v1</id>
    <updated>2026-01-01T00:00:00Z</updated>
    <published>2026-01-01T00:00:00Z</published>
    <title>A Study of Multi-Agent LLM Systems</title>
    <summary>  This paper explores multi-agent reinforcement learning approaches for LLM agents.  </summary>
    <author><name>Jane Doe</name></author>
    <author><name>John Smith</name></author>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2501.00002v1</id>
    <updated>2026-01-02T00:00:00Z</updated>
    <published>2026-01-02T00:00:00Z</published>
    <title>Unrelated Topic in Botany</title>
    <summary>This paper is about plant biology and has nothing to do with our keywords.</summary>
    <author><name>Alice Brown</name></author>
  </entry>
</feed>`;

test("parseArxivAtom은 entry 블록에서 id/title/authors/summary/published를 추출한다", () => {
  const entries = parseArxivAtom(ARXIV_FIXTURE);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].id, "http://arxiv.org/abs/2501.00001v1");
  assert.equal(entries[0].title, "A Study of Multi-Agent LLM Systems");
  assert.deepEqual(entries[0].authors, ["Jane Doe", "John Smith"]);
  assert.match(entries[0].summary, /multi-agent reinforcement learning/);
  assert.equal(entries[0].published, "2026-01-01T00:00:00Z");
  assert.equal(entries[1].authors.length, 1);
});

const RSS_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
<title>Test Feed</title>
<item>
  <title><![CDATA[Cloudflare Ships New Durable Objects Feature]]></title>
  <link>https://blog.cloudflare.com/durable-objects-feature/</link>
  <guid>https://blog.cloudflare.com/durable-objects-feature/</guid>
  <pubDate>Mon, 01 Jan 2026 00:00:00 GMT</pubDate>
  <description><![CDATA[<p>We are excited to announce <strong>Durable Objects</strong> improvements for edge computing.</p>]]></description>
</item>
<item>
  <title>Random Cooking Recipe</title>
  <link>https://example.com/recipe</link>
  <guid>https://example.com/recipe</guid>
  <pubDate>Tue, 02 Jan 2026 00:00:00 GMT</pubDate>
  <description>A recipe for chocolate cake with no relevant keywords.</description>
</item>
</channel>
</rss>`;

test("parseFeed는 RSS item 블록을 파싱하고 CDATA+HTML 태그를 스트립한다", () => {
  const items = parseFeed(RSS_FIXTURE);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, "Cloudflare Ships New Durable Objects Feature");
  assert.equal(items[0].link, "https://blog.cloudflare.com/durable-objects-feature/");
  assert.equal(items[0].summary.includes("<p>"), false);
  assert.equal(items[0].summary.includes("<strong>"), false);
  assert.match(items[0].summary, /Durable Objects improvements for edge computing/);
});

const ATOM_FALLBACK_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>tag:openai.com,2026:/blog/webgpu-inference</id>
    <title>WebGPU Inference Update</title>
    <link href="https://openai.com/blog/webgpu-inference" rel="alternate"/>
    <updated>2026-01-03T00:00:00Z</updated>
    <summary>An update about WebGPU-based inference for large models.</summary>
  </entry>
</feed>`;

test("parseFeed는 RSS item이 없으면 Atom entry로 폴백한다", () => {
  const items = parseFeed(ATOM_FALLBACK_FIXTURE);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "WebGPU Inference Update");
  assert.equal(items[0].link, "https://openai.com/blog/webgpu-inference");
  assert.match(items[0].summary, /WebGPU-based inference/);
});

test("scoreText는 제목 2배·본문 1배 가중치로 매칭 키워드를 집계한다", () => {
  const keywords = [
    { term: "llm", weight: 3 },
    { term: "multi-agent", weight: 3 },
    { term: "botany", weight: 1 },
  ];
  const { score, matched } = scoreText(
    "A Study of Multi-Agent LLM Systems",
    "This paper explores multi-agent reinforcement learning approaches for LLM agents.",
    keywords
  );
  assert.equal(score, 18);
  assert.deepEqual(matched.sort(), ["llm", "multi-agent"]);
});

test("selectTopCandidates는 점수 내림차순 정렬 후 상위 N개만 반환한다", () => {
  const items = [{ score: 5 }, { score: 20 }, { score: 1 }, { score: 12 }];
  const top = selectTopCandidates(items, 2);
  assert.deepEqual(top.map((i) => i.score), [20, 12]);
  assert.equal(items[0].score, 5);
});

test("cutUnseen은 lastSeenId 이전 항목만 남긴다(신규순 정렬 가정)", () => {
  const entries = [{ id: "c" }, { id: "b" }, { id: "a" }];
  assert.deepEqual(cutUnseen(entries, "b"), [{ id: "c" }]);
  assert.deepEqual(cutUnseen(entries, undefined), entries);
  assert.deepEqual(cutUnseen(entries, "not-found"), entries);
});

test("advanceCursor는 새 커서로 상태를 갱신하되 원본은 불변으로 둔다", () => {
  const state: CollectState = { arxiv: { "cs.CL": "old-id" }, rss: {} };
  const next = advanceCursor(state, "arxiv", "cs.CL", "new-id");
  assert.equal(next.arxiv["cs.CL"], "new-id");
  assert.equal(state.arxiv["cs.CL"], "old-id");

  const unchanged = advanceCursor(state, "arxiv", "cs.CL", undefined);
  assert.equal(unchanged, state);
});

test("stripHtmlTags는 script/style을 제거하고 태그를 벗긴다", () => {
  const html = "<div>Hello <script>alert(1)</script><style>.x{color:red}</style><b>World</b></div>";
  assert.equal(stripHtmlTags(html), "Hello World");
});

test("truncate는 max 길이를 넘으면 자른다", () => {
  assert.equal(truncate("hello", 10), "hello");
  assert.equal(truncate("a".repeat(600), 500).length, 500);
});

test("candidateId는 origin의 sha256 앞 12자를 반환하고 결정론적이다", () => {
  const id1 = candidateId("https://arxiv.org/abs/2501.00001v1");
  const id2 = candidateId("https://arxiv.org/abs/2501.00001v1");
  const id3 = candidateId("https://arxiv.org/abs/2501.00002v1");
  assert.equal(id1, id2);
  assert.equal(id1.length, 12);
  assert.notEqual(id1, id3);
});

test("extractTag는 속성이 있는 태그도 대소문자 무시하고 추출한다", () => {
  const block = '<Link href="https://example.com" rel="alternate"/><Title lang="en">Hello World</Title>';
  assert.equal(extractTag(block, "title"), "Hello World");
});

test("decodeXmlEntities는 이름 엔티티와 숫자 엔티티를 모두 디코딩한다", () => {
  assert.equal(decodeXmlEntities("Tom &amp; Jerry"), "Tom & Jerry");
  assert.equal(decodeXmlEntities("&lt;div&gt;"), "<div>");
  assert.equal(decodeXmlEntities("&#65;&#x42;"), "AB");
});

// --- M8: unify collection (runCollect -> core branch) + legacy inbox migration ---
// See CONTRACT.md "# M8 확장" section, "## mind: 사용자·역할" > collection unification.

function makeConfig(overrides?: Partial<CosmosConfig>): CosmosConfig {
  return {
    collect: {
      arxiv: { categories: [], max_per_category: 5 },
      rss: { feeds: [] },
      profile: { keywords: [] },
      max_pending_per_run: 5,
    },
    watcher: { dirs: [] },
    policy: { arxiv: "direct", rss: "direct", manual: "direct", session: "direct" },
    lifecycle: { birth_min: 3, birth_cohesion: 0.5, merge_sim: 0.8 },
    ...overrides,
  } as CosmosConfig;
}

function makeFetchImpl(responses: Record<string, string>): typeof fetch {
  return (async (url: string | URL) => {
    const key = url.toString();
    const xml = responses[key];
    if (xml === undefined) {
      return { ok: false, status: 404, text: async () => "" } as unknown as Response;
    }
    return { ok: true, status: 200, text: async () => xml } as unknown as Response;
  }) as unknown as typeof fetch;
}

function makeCollectFakeCore(opts: {
  createBranchImpl?: (req: { name: string; created_by?: string }) => Promise<BranchSummary>;
  branches?: BranchSummary[];
  ingestCalls?: IngestRequest[];
} = {}): CoreClient {
  const ingestCalls = opts.ingestCalls ?? [];
  return {
    async createBranch(req: { name: string; created_by?: string }): Promise<BranchSummary> {
      if (opts.createBranchImpl) return opts.createBranchImpl(req);
      return { id: `id-${req.name}`, name: req.name, status: "open", created_at: new Date().toISOString() };
    },
    async listBranches(): Promise<BranchSummary[]> {
      return opts.branches ?? [];
    },
    async ingest(req: IngestRequest) {
      ingestCalls.push(req);
      return { doc_ids: ["d"], chunks: 1 };
    },
  } as unknown as CoreClient;
}

test("runCollect는 브랜치명 충돌(409) 시 -2 접미사로 재시도하고 branch_id로 ingest한다", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const baseName = `collect/${today}`;
  let createAttempts = 0;
  const ingestCalls: IngestRequest[] = [];

  const core = makeCollectFakeCore({
    ingestCalls,
    createBranchImpl: async (req) => {
      createAttempts += 1;
      if (req.name === baseName) {
        throw new CoreHttpError("conflict", 409);
      }
      return { id: "branch-2", name: req.name, status: "open", created_at: new Date().toISOString() };
    },
  });

  const config = makeConfig({
    collect: {
      arxiv: { categories: [], max_per_category: 5 },
      rss: { feeds: [{ url: "https://blog.cloudflare.com/rss/", enabled: true }] },
      profile: { keywords: [{ term: "durable objects", weight: 3 }] },
      max_pending_per_run: 5,
    },
  });

  const dataDir = await mkdtemp(path.join(tmpdir(), "cosmos-collect-test-"));
  try {
    const summary = await runCollect({
      core,
      config,
      dataDir,
      fetchImpl: makeFetchImpl({ "https://blog.cloudflare.com/rss/": RSS_FIXTURE }),
    });

    assert.equal(summary.branch_name, `${baseName}-2`);
    assert.equal(createAttempts, 2);
    assert.equal(summary.written, 2);
    assert.equal(ingestCalls.length, 2);
    for (const call of ingestCalls) {
      assert.equal(call.branch_id, "branch-2");
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("migrateLegacyInbox는 pending 항목을 inbox-legacy 브랜치로 옮기고 migrated로 이동시킨다", async () => {
  const ingestCalls: IngestRequest[] = [];
  let createCalls = 0;

  const core = makeCollectFakeCore({
    ingestCalls,
    createBranchImpl: async (req) => {
      createCalls += 1;
      return { id: "legacy-branch", name: req.name, status: "open", created_at: new Date().toISOString() };
    },
  });

  const dataDir = await mkdtemp(path.join(tmpdir(), "cosmos-collect-test-"));
  try {
    const pendingDir = path.join(dataDir, "inbox", "pending");
    await mkdir(pendingDir, { recursive: true });
    const candidate: PendingCandidate = {
      id: "cand-1",
      origin: "https://example.com/legacy-doc",
      source_type: "rss",
      title: "Legacy Candidate",
      summary: "레거시 inbox 후보",
      score: 10,
    } as PendingCandidate;
    await writeFile(path.join(pendingDir, "cand-1.json"), JSON.stringify(candidate), "utf8");

    const result = await migrateLegacyInbox({ core, dataDir });

    assert.equal(result.migrated, 1);
    assert.equal(result.branch_name, "inbox-legacy");
    assert.equal(createCalls, 1);
    assert.equal(ingestCalls.length, 1);
    assert.equal(ingestCalls[0].branch_id, "legacy-branch");
    assert.equal(ingestCalls[0].docs[0].origin, "https://example.com/legacy-doc");

    const migratedDir = path.join(dataDir, "inbox", "migrated");
    const migratedFiles = await readdir(migratedDir);
    assert.deepEqual(migratedFiles, ["cand-1.json"]);

    const remainingPending = await readdir(pendingDir);
    assert.deepEqual(remainingPending, []);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("migrateLegacyInbox는 pending 디렉터리가 없으면 core를 호출하지 않고 0건을 반환한다", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cosmos-collect-test-"));
  try {
    const core = {
      async createBranch(): Promise<BranchSummary> {
        throw new Error("createBranch가 호출되면 안 됩니다.");
      },
      async listBranches(): Promise<BranchSummary[]> {
        throw new Error("listBranches가 호출되면 안 됩니다.");
      },
      async ingest() {
        throw new Error("ingest가 호출되면 안 됩니다.");
      },
    } as unknown as CoreClient;

    const result = await migrateLegacyInbox({ core, dataDir });
    assert.deepEqual(result, { migrated: 0, branch_name: "" });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
