import { test } from "node:test";
import assert from "node:assert/strict";

import {
  __resetClaudeExePathCacheForTest,
  ClaudeCliLlmClient,
  resolveClaudeExePath,
  resolveTimeoutMs,
} from "./llm.js";

const SONNET_ENV = "COSMOS_LLM_TIMEOUT_SONNET_MS";
const OPUS_ENV = "COSMOS_LLM_TIMEOUT_OPUS_MS";

/** resolveClaudeExePath에 주입할 탐색 대역을 만든다. calls는 (command, args) 호출 기록. */
function fakeProbe(
  stdout: string | null,
  status: number | null,
  calls: Array<{ command: string; args: string[] }> = []
): (command: string, args: string[]) => { status: number | null; stdout: string | null } {
  return (command, args) => {
    calls.push({ command, args });
    return { status, stdout };
  };
}

function clearOverrides(): void {
  delete process.env[SONNET_ENV];
  delete process.env[OPUS_ENV];
}

test("모델별 기본 타임아웃: sonnet=360000ms, opus=420000ms", () => {
  clearOverrides();
  assert.equal(resolveTimeoutMs("sonnet"), 360_000);
  assert.equal(resolveTimeoutMs("opus"), 420_000);
});

test("env 오버라이드가 있으면 그 값을 사용한다", () => {
  process.env[SONNET_ENV] = "5000";
  process.env[OPUS_ENV] = "9000";
  try {
    assert.equal(resolveTimeoutMs("sonnet"), 5000);
    assert.equal(resolveTimeoutMs("opus"), 9000);
  } finally {
    clearOverrides();
  }
});

test("env 오버라이드 파싱 실패 시 모델별 기본값으로 폴백한다", () => {
  process.env[SONNET_ENV] = "not-a-number";
  process.env[OPUS_ENV] = "-100";
  try {
    assert.equal(resolveTimeoutMs("sonnet"), 360_000);
    assert.equal(resolveTimeoutMs("opus"), 420_000);
  } finally {
    clearOverrides();
  }
});

test("win32 분기: where.exe로 탐색하고 .cmd보다 .exe를 우선한다", () => {
  __resetClaudeExePathCacheForTest();
  try {
    const calls: Array<{ command: string; args: string[] }> = [];
    const probe = fakeProbe("C:\\tools\\claude.cmd\r\nC:\\tools\\claude.exe\r\n", 0, calls);
    const result = resolveClaudeExePath("win32", probe);
    assert.equal(result, "C:\\tools\\claude.exe");
    assert.deepEqual(calls, [{ command: "where.exe", args: ["claude"] }]);
  } finally {
    __resetClaudeExePathCacheForTest();
  }
});

test("win32 분기: where.exe 실패 시 즉시 에러를 던지고, 캐시되어 재호출해도 재탐색하지 않는다", () => {
  __resetClaudeExePathCacheForTest();
  try {
    const calls: Array<{ command: string; args: string[] }> = [];
    const probe = fakeProbe(null, 1, calls);
    assert.throws(
      () => resolveClaudeExePath("win32", probe),
      /claude CLI 실행파일을 찾을 수 없습니다 \(where\.exe claude 실패\)/
    );
    assert.throws(
      () => resolveClaudeExePath("win32", probe),
      /claude CLI 실행파일을 찾을 수 없습니다 \(where\.exe claude 실패\)/
    );
    assert.equal(calls.length, 1, "캐시된 실패는 재탐색하지 않아야 한다");
  } finally {
    __resetClaudeExePathCacheForTest();
  }
});

test("비-win32 분기: which로 탐색해 성공하면 그 경로를 반환한다", () => {
  __resetClaudeExePathCacheForTest();
  try {
    const calls: Array<{ command: string; args: string[] }> = [];
    const probe = fakeProbe("/usr/local/bin/claude\n", 0, calls);
    const result = resolveClaudeExePath("linux", probe);
    assert.equal(result, "/usr/local/bin/claude");
    assert.deepEqual(calls, [{ command: "which", args: ["claude"] }]);
  } finally {
    __resetClaudeExePathCacheForTest();
  }
});

test("비-win32 분기: which가 실패해도(exit != 0) 즉시 던지지 않고 claude 리터럴로 폴백한다", () => {
  __resetClaudeExePathCacheForTest();
  try {
    const result = resolveClaudeExePath("linux", fakeProbe(null, 1));
    assert.equal(result, "claude");
  } finally {
    __resetClaudeExePathCacheForTest();
  }
});

test("비-win32 분기: which 실행 자체가 안 되어도(status null, 컨테이너에 which 없음) claude 리터럴로 폴백한다", () => {
  __resetClaudeExePathCacheForTest();
  try {
    const result = resolveClaudeExePath("darwin", fakeProbe(null, null));
    assert.equal(result, "claude");
  } finally {
    __resetClaudeExePathCacheForTest();
  }
});

test("PATH 위임된 claude 리터럴이 실제로 없으면 spawn ENOENT를 한국어 '찾을 수 없음' 에러로 변환한다", async () => {
  __resetClaudeExePathCacheForTest();
  try {
    // which/where.exe가 성공했다고 응답하지만, 그 결과가 실제로는 존재하지 않는
    // 실행파일이라고 가정 — 실제 spawn 시점에 ENOENT가 나야 한다.
    resolveClaudeExePath(process.platform, fakeProbe("cosmos-definitely-missing-claude-binary-xyz", 0));
    const client = new ClaudeCliLlmClient();
    await assert.rejects(
      () => client.complete("hi"),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match((err as Error).message, /claude CLI 실행파일을 찾을 수 없습니다/);
        return true;
      }
    );
  } finally {
    __resetClaudeExePathCacheForTest();
  }
});
