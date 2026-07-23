import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { anyDirExists } from "./cli.js";

// M5: at serve startup, if every watcher target directory is missing, the watcher isn't started at all.
// anyDirExists is that decision function.

test("anyDirExists는 대상 디렉터리가 모두 존재하지 않으면 false를 반환한다", async () => {
  const missing1 = path.join(tmpdir(), `cosmos-cli-test-missing-1-${Date.now()}`);
  const missing2 = path.join(tmpdir(), `cosmos-cli-test-missing-2-${Date.now()}`);
  const result = await anyDirExists([missing1, missing2]);
  assert.equal(result, false);
});

test("anyDirExists는 대상 디렉터리 중 하나라도 존재하면 true를 반환한다", async () => {
  const existing = await mkdtemp(path.join(tmpdir(), "cosmos-cli-test-exists-"));
  const missing = path.join(tmpdir(), `cosmos-cli-test-missing-${Date.now()}`);
  try {
    const result = await anyDirExists([missing, existing]);
    assert.equal(result, true);
  } finally {
    await rm(existing, { recursive: true, force: true });
  }
});

test("anyDirExists는 빈 배열을 넘기면 false를 반환한다", async () => {
  const result = await anyDirExists([]);
  assert.equal(result, false);
});
