// M9.6 personal knowledge repo connector unit tests — no real GitHub needed (fetch fake + handmade tar.gz).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import path from "node:path";

import { extractTarFiles, loadRepos, syncAllRepos, syncRepo, upsertRepo, upsertSharedRepo, type RepoEntry } from "./repos.js";
import type { CoreClient, IngestRequest, IngestResponse } from "./core-client.js";

function tarEntry(name: string, content: string, typeflag = "0"): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, "utf8");
  header.write("0000644\0", 100, "ascii");
  header.write("0000000\0", 108, "ascii");
  header.write("0000000\0", 116, "ascii");
  const size = Buffer.byteLength(content, "utf8");
  header.write(size.toString(8).padStart(11, "0") + "\0", 124, "ascii");
  header.write("00000000000\0", 136, "ascii");
  header.write("        ", 148, "ascii");
  header[156] = typeflag.charCodeAt(0);
  header.write("ustar", 257, "ascii");
  let sum = 0;
  for (const b of header) sum += b;
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  const body = Buffer.alloc(Math.ceil(size / 512) * 512);
  body.write(content, 0, "utf8");
  return Buffer.concat([header, body]);
}

function makeTar(entries: Array<[string, string]>): Buffer {
  return Buffer.concat([...entries.map(([n, c]) => tarEntry(n, c)), Buffer.alloc(1024)]);
}

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "cosmos-repos-"));
}

function recordingCore() {
  const ingests: IngestRequest[] = [];
  const core = {
    async ingest(req: IngestRequest): Promise<IngestResponse> {
      ingests.push(req);
      return {
        ingested: req.docs.map((d, i) => ({
          doc_id: `d${i}`, origin: d.origin, chunks: 1, duplicate: false, replaced: false, cluster_slug: null, fit: null,
        })),
      };
    },
  } as unknown as CoreClient;
  return { core, ingests };
}

function fakeGithub(tarGz: Buffer, sha = "abc123") {
  return (async (url: string | URL | Request) => {
    const u = String(url);
    const json = (obj: unknown) => new Response(JSON.stringify(obj), { status: 200 });
    if (/\/repos\/[^/]+\/[^/]+$/.test(u)) return json({ default_branch: "main" });
    if (u.includes("/commits/")) return json({ sha });
    if (u.includes("/tarball/")) return new Response(new Uint8Array(tarGz), { status: 200 });
    return new Response("nf", { status: 404 });
  }) as typeof fetch;
}

test("extractTarFiles는 일반 파일·prefix·GNU longname을 읽고 그 외 타입은 건너뛴다", () => {
  const long = "kb-abc/" + "가".repeat(60) + "/노트.md"; // exceeds 100 chars (UTF-8)
  const tar = Buffer.concat([
    tarEntry("kb-abc/일반.md", "# 일반"),
    tarEntry("././@LongLink", long, "L"),
    tarEntry("kb-abc/잘린이름.md", "# 롱네임 본문"),
    tarEntry("kb-abc/디렉토리/", "", "5"),
    Buffer.alloc(1024),
  ]);
  const files = extractTarFiles(tar);
  assert.equal(files.get("kb-abc/일반.md")?.toString("utf8"), "# 일반");
  assert.equal(files.get(long)?.toString("utf8"), "# 롱네임 본문");
  assert.equal([...files.keys()].some((k) => k.endsWith("디렉토리/")), false);
});

test("upsertRepo는 형식을 검증하고 owner당 1건으로 교체한다", async () => {
  const dir = await tempDir();
  await assert.rejects(() => upsertRepo({ owner: "a", repo: "잘못된형식" }, dir));
  await upsertRepo({ owner: "a", repo: "org/one" }, dir);
  await upsertRepo({ owner: "b", repo: "org/two" }, dir);
  await upsertRepo({ owner: "a", repo: "org/three", branch: "dev" }, dir);
  const entries = await loadRepos(dir);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.find((e) => e.owner === "a")?.repo, "org/three");
});

test("syncRepo는 tarball의 .md만 owner ingest하고 숨김/비md는 거른다", async () => {
  const tarGz = gzipSync(makeTar([
    ["kb-abc/시작.md", "# 시작 노트\n내용"],
    ["kb-abc/폴더/딥.md", "본문만 있고 제목줄 없음"],
    ["kb-abc/.github/워크플로.md", "# 숨김"],
    ["kb-abc/스크립트.ps1", "코드"],
    ["kb-abc/빈파일.md", "   \n"],
  ]));
  const { core, ingests } = recordingCore();
  const entry: RepoEntry = { owner: "철수", repo: "org/kb" };
  const result = await syncRepo(entry, { core, fetchImpl: fakeGithub(tarGz) });

  assert.equal(result.changed, true);
  assert.equal(result.ingested, 2);
  assert.equal(ingests.length, 1);
  assert.equal(ingests[0].owner, "철수");
  const origins = ingests[0].docs.map((d) => d.origin).sort();
  assert.deepEqual(origins, ["knowledge://철수/시작.md", "knowledge://철수/폴더/딥.md"]);
  const titled = ingests[0].docs.find((d) => d.origin.endsWith("시작.md"));
  assert.equal(titled?.title, "시작 노트");
  const untitled = ingests[0].docs.find((d) => d.origin.endsWith("딥.md"));
  assert.equal(untitled?.title, "딥");
  assert.equal(entry.last_sha, "abc123");
  assert.equal(entry.branch, "main");
});

test("공용 레포(shared)는 owner 없이 knowledge://shared/<이름>/ 네임스페이스로 ingest한다", async () => {
  const dir = await tempDir();
  const tarGz = gzipSync(makeTar([["knowledge-commons-abc/wiki/교훈.md", "# 교훈\n본문"]]));
  const { core, ingests } = recordingCore();

  const entry = await upsertSharedRepo({ repo: "ONOFFERDEV/knowledge-commons" }, dir);
  assert.equal(entry.owner, "@shared/knowledge-commons");
  assert.equal(entry.shared, true);
  // The second shared repo does not overwrite the first (1 entry per repo).
  await upsertSharedRepo({ repo: "ONOFFERDEV/knowledge-internal" }, dir);
  await upsertSharedRepo({ repo: "ONOFFERDEV/knowledge-commons", branch: "main" }, dir);
  const entries = await loadRepos(dir);
  assert.equal(entries.filter((e) => e.shared).length, 2, "공용 2레포 공존");

  const result = await syncRepo(entry, { core, fetchImpl: fakeGithub(tarGz) });
  assert.equal(result.ingested, 1);
  assert.equal(ingests.length, 1);
  assert.equal("owner" in ingests[0] && ingests[0].owner !== undefined, false, "owner 미지정(shared 스코프)");
  assert.deepEqual(ingests[0].docs.map((d) => d.origin), ["knowledge://shared/knowledge-commons/wiki/교훈.md"]);
});

test("syncRepo는 head sha 무변경이면 tarball 없이 no-op", async () => {
  const tarGz = gzipSync(makeTar([["kb-abc/시작.md", "# 시작"]]));
  const { core, ingests } = recordingCore();
  const entry: RepoEntry = { owner: "철수", repo: "org/kb", last_sha: "abc123", branch: "main" };
  const result = await syncRepo(entry, { core, fetchImpl: fakeGithub(tarGz) });
  assert.equal(result.changed, false);
  assert.equal(ingests.length, 0);
});

test("syncAllRepos는 항목별 실패를 기록하고 계속 진행한다", async () => {
  const dir = await tempDir();
  await upsertRepo({ owner: "a", repo: "org/dead" }, dir);
  await upsertRepo({ owner: "b", repo: "org/alive" }, dir);
  const tarGz = gzipSync(makeTar([["kb-abc/살아있음.md", "# ok"]]));
  const fetchImpl = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("org/dead")) return new Response("x", { status: 404 });
    return (fakeGithub(tarGz) as (u: string | URL | Request) => Promise<Response>)(url);
  }) as typeof fetch;

  const { core } = recordingCore();
  const results = await syncAllRepos({ core, dataDir: dir, fetchImpl });
  assert.equal(results.length, 2);
  assert.ok(results.find((r) => r.owner === "a")?.error);
  assert.equal(results.find((r) => r.owner === "b")?.ingested, 1);
  const saved = await loadRepos(dir);
  assert.ok(saved.find((e) => e.owner === "a")?.last_error);
  assert.equal(saved.find((e) => e.owner === "b")?.last_sha, "abc123");
});
