#!/usr/bin/env node
// Cosmos M0 시드 코퍼스 수집기.
// 소스 A: 전역 위키(~/.claude/wiki/*.md, index.md·log.md 제외) -> data/seed/wiki/
// 소스 B: 프로젝트 메모리(~/.claude/projects/D--/memory/*.md, MEMORY.md·dashboard.md·_templates/ 제외) -> data/seed/memory/
// 내용 무변형 복사 + data/seed/manifest.json 생성 (CONTRACT.md '시드 매니페스트' 절 형식).
// 외부 의존성 0. 재실행 시 대상 디렉터리를 비우고 전체 재생성(idempotent).

import { readdir, readFile, writeFile, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";

const WIKI_SRC = "C:\\Users\\User\\.claude\\wiki";
const MEMORY_SRC = "C:\\Users\\User\\.claude\\projects\\D--\\memory";
const SEED_ROOT = "D:\\cosmos\\data\\seed";

const WIKI_EXCLUDE = new Set(["index.md", "log.md"]);
const MEMORY_EXCLUDE = new Set(["MEMORY.md", "dashboard.md"]);

function extractTitle(content, fallback) {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return fallback;
  const fm = fmMatch[1];
  const titleMatch = fm.match(/^title:\s*(.+)$/m);
  const nameMatch = fm.match(/^name:\s*(.+)$/m);
  const raw = titleMatch?.[1] ?? nameMatch?.[1];
  if (!raw) return fallback;
  return raw.trim().replace(/^["']|["']$/g, "");
}

async function listMarkdownFiles(dir, excludeSet) {
  const dirents = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const d of dirents) {
    if (!d.isFile()) continue; // skips subdirectories like _templates
    if (!d.name.endsWith(".md")) continue;
    if (excludeSet.has(d.name)) continue;
    files.push(d.name);
  }
  files.sort();
  return files;
}

async function collectSource(srcDir, excludeSet, destSubdir) {
  const destDir = path.join(SEED_ROOT, destSubdir);
  await rm(destDir, { recursive: true, force: true });
  await mkdir(destDir, { recursive: true });

  const filenames = await listMarkdownFiles(srcDir, excludeSet);
  const entries = [];
  for (const filename of filenames) {
    const origin = path.join(srcDir, filename);
    const content = await readFile(origin, "utf8");
    const destPath = path.join(destDir, filename);
    await writeFile(destPath, content, "utf8");

    const relFile = `${destSubdir}/${filename}`;
    const fallbackTitle = path.basename(filename, ".md");
    entries.push({
      file: relFile,
      origin,
      source_type: "session",
      title: extractTitle(content, fallbackTitle),
    });
  }
  return entries;
}

async function main() {
  await mkdir(SEED_ROOT, { recursive: true });

  const wikiEntries = await collectSource(WIKI_SRC, WIKI_EXCLUDE, "wiki");
  const memoryEntries = await collectSource(MEMORY_SRC, MEMORY_EXCLUDE, "memory");

  const manifest = {
    generated_at: new Date().toISOString(),
    entries: [...wikiEntries, ...memoryEntries],
  };

  const manifestPath = path.join(SEED_ROOT, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  console.log(`wiki: ${wikiEntries.length}건`);
  console.log(`memory: ${memoryEntries.length}건`);
  console.log(`총 문서 수: ${manifest.entries.length}건`);
  console.log(`manifest: ${manifestPath}`);
}

main().catch((err) => {
  console.error("collect_seed 실패:", err);
  process.exitCode = 1;
});
