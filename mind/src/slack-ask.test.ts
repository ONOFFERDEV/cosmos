import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { SlackAskBridge, parseAskMessage, formatSlackReply, type SlackAskDeps, type AskDispatch } from "./slack-ask.js";
import { addUser } from "./users.js";
import type { CoreClient } from "./core-client.js";
import type { LlmClient } from "./llm.js";
import type { AskEnvelope } from "./envelope.js";

interface SlackCall {
  method: string;
  body: Record<string, unknown>;
  contentType: string | undefined;
}

/** A fetchImpl that branches per Slack method AND per call body, unlike invite.test.ts's static mock —
 * needed because SlackAskBridge calls conversations.history twice per channel with different bodies
 * (bootstrap watermark-seed, then incremental poll). Parses the body as application/x-www-form-urlencoded
 * (Slack's actual wire format — see invite.ts's callSlack) rather than JSON, so a regression back to a
 * JSON body would be caught here instead of silently round-tripping. */
function makeFetch(
  handlers: Record<string, (body: Record<string, unknown>) => Record<string, unknown>>,
  calls: SlackCall[]
): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const method = url.toString().replace("https://slack.com/api/", "");
    const body = init?.body
      ? (Object.fromEntries(new URLSearchParams(init.body as string)) as Record<string, unknown>)
      : {};
    const headers = init?.headers as Record<string, string> | undefined;
    calls.push({ method, body, contentType: headers?.["Content-Type"] });
    const handler = handlers[method];
    const payload = handler ? handler(body) : { ok: false, error: "not_mocked" };
    return { ok: true, json: async () => payload } as unknown as Response;
  }) as unknown as typeof fetch;
}

function makeBridge(fetchImpl: typeof fetch, dataDir: string, askDispatch: AskDispatch): SlackAskBridge {
  const deps: SlackAskDeps = {
    core: {} as CoreClient,
    llm: {} as LlmClient,
    token: "xoxb-test",
    dataDir,
    fetchImpl,
  };
  return new SlackAskBridge(deps, askDispatch);
}

function makeEnvelope(overrides: Partial<AskEnvelope> = {}): AskEnvelope {
  return {
    answer: "답변",
    sentences: [],
    sources: [],
    trace: [],
    insufficient: false,
    mode: "fast",
    cost: { llm_calls: 1, secs: 0.5, model: "test-model" },
    ...overrides,
  };
}

async function writeInvite(dataDir: string, name: string, slackUserId: string): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const invites = [
    { name, slack_user: slackUserId, channel: "C-setup", ts: "1.1", sent_at: "2026-07-01T00:00:00.000Z", status: "done" },
  ];
  await writeFile(path.join(dataDir, "invites.json"), JSON.stringify(invites, null, 2), "utf8");
}

async function writeState(dataDir: string, state: Record<string, string>): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, "slack-ask.state.json"), JSON.stringify(state), "utf8");
}

// ---- parseAskMessage ----

test("parseAskMessage는 '?'로 시작하지 않는 텍스트를 무시한다", () => {
  assert.equal(parseAskMessage("그냥 메시지입니다"), null);
  assert.equal(parseAskMessage(""), null);
  assert.equal(parseAskMessage("   "), null);
});

test("parseAskMessage는 '?' 뒤에 내용이 없으면 무시한다", () => {
  assert.equal(parseAskMessage("?"), null);
  assert.equal(parseAskMessage("??"), null);
  assert.equal(parseAskMessage("?   "), null);
});

test("parseAskMessage는 '?질문'을 auto 모드로 파싱하고 앞뒤 공백을 정리한다", () => {
  const parsed = parseAskMessage("  ?  오늘 날씨 어때  ");
  assert.ok(parsed);
  assert.equal(parsed!.question, "오늘 날씨 어때");
  assert.equal(parsed!.mode, "fast", "전역 키워드가 없는 질문은 fast로 분류되어야 한다");
});

test("parseAskMessage는 전역 키워드가 있는 질문을 global 모드로 분류한다", () => {
  const parsed = parseAskMessage("?전체 목록 좀 알려줘");
  assert.ok(parsed);
  assert.equal(parsed!.question, "전체 목록 좀 알려줘");
  assert.equal(parsed!.mode, "global");
});

test("parseAskMessage는 '??'를 항상 deep 모드로 강제하며 전역 키워드보다 우선한다", () => {
  const plain = parseAskMessage("??질문입니다");
  assert.ok(plain);
  assert.equal(plain!.question, "질문입니다");
  assert.equal(plain!.mode, "deep");

  const withGlobalKeyword = parseAskMessage("??전체 목록 보여줘");
  assert.ok(withGlobalKeyword);
  assert.equal(withGlobalKeyword!.mode, "deep", "'??'는 전역 키워드가 있어도 deep을 강제해야 한다");
});

// ---- formatSlackReply ----

test("formatSlackReply는 출처가 없으면 답변만 반환한다", () => {
  assert.equal(formatSlackReply(makeEnvelope({ answer: "답변입니다" })), "답변입니다");
});

test("formatSlackReply는 출처를 최대 5개까지 나열하고 3500자를 넘으면 잘라낸다", () => {
  const sources = Array.from({ length: 7 }, (_, i) => ({
    n: i + 1,
    origin: `origin-${i + 1}`,
    title: i === 0 ? "제목" : undefined,
    chunk_id: `c${i}`,
    char_start: 0,
    char_end: 10,
  }));
  const withSources = formatSlackReply(makeEnvelope({ answer: "답변", sources }));
  const sourceLines = withSources.split("\n").filter((l) => l.startsWith("  ["));
  assert.equal(sourceLines.length, 5, "출처는 최대 5개까지만 나열되어야 한다");
  assert.match(withSources, /\[1\] 제목 — origin-1/);
  assert.ok(!withSources.includes("origin-6"), "6번째 이후 출처는 포함되지 않아야 한다");

  const longAnswer = "가".repeat(4000);
  const truncated = formatSlackReply(makeEnvelope({ answer: longAnswer }));
  assert.equal(truncated.length, 3501, "3500자 + 말줄임표 1자");
  assert.ok(truncated.endsWith("…"));
});

// ---- SlackAskBridge.poll() ----

test("채널을 처음 보면 과거 메시지에 답하지 않고 워터마크만 저장한다(부트스트랩)", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cosmos-slackask-"));
  try {
    const calls: SlackCall[] = [];
    const fetchImpl = makeFetch(
      {
        "conversations.list": () => ({ ok: true, channels: [{ id: "C1", user: "U1" }] }),
        "auth.test": () => ({ ok: true, user_id: "UBOT" }),
        "conversations.history": () => ({ ok: true, messages: [{ ts: "100.100", text: "?오래된 질문", user: "U1" }] }),
      },
      calls
    );

    const dispatchCalls: unknown[] = [];
    const askDispatch: AskDispatch = async () => {
      dispatchCalls.push(1);
      return makeEnvelope();
    };

    const bridge = makeBridge(fetchImpl, dataDir, askDispatch);
    await bridge.poll();

    assert.equal(dispatchCalls.length, 0, "부트스트랩 폴링은 질문에 답하지 않는다");
    assert.equal(calls.filter((c) => c.method === "chat.postMessage").length, 0);

    const state = JSON.parse(await readFile(path.join(dataDir, "slack-ask.state.json"), "utf8"));
    assert.equal(state["C1"], "100.100");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("conversations.list 호출은 application/x-www-form-urlencoded로 전송되고 types=im을 포함한다", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cosmos-slackask-"));
  try {
    const calls: SlackCall[] = [];
    const fetchImpl = makeFetch(
      {
        "conversations.list": () => ({ ok: true, channels: [] }),
        "auth.test": () => ({ ok: true, user_id: "UBOT" }),
      },
      calls
    );

    const bridge = makeBridge(fetchImpl, dataDir, async () => makeEnvelope());
    await bridge.poll();

    const listCall = calls.find((c) => c.method === "conversations.list");
    assert.ok(listCall, "conversations.list가 호출되어야 한다");
    assert.match(
      listCall!.contentType ?? "",
      /x-www-form-urlencoded/,
      "JSON 바디로 회귀하면 실패해야 한다 — Slack의 list/history는 JSON을 파싱하지 않는다"
    );
    assert.equal(listCall!.body.types, "im");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("봇 메시지와 봇 자신이 보낸 메시지는 건너뛰고 실제 사용자의 질문만 처리한다", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cosmos-slackask-"));
  try {
    await writeInvite(dataDir, "alice", "U1");
    await addUser("alice", "member", dataDir);
    await writeState(dataDir, { C1: "100.0" });

    const calls: SlackCall[] = [];
    const fetchImpl = makeFetch(
      {
        "conversations.list": () => ({ ok: true, channels: [{ id: "C1", user: "U1" }] }),
        "auth.test": () => ({ ok: true, user_id: "UBOT" }),
        "conversations.history": () => ({
          ok: true,
          messages: [
            { ts: "100.1", text: "?봇 메시지", bot_id: "B1" },
            { ts: "100.2", text: "?봇 자신", user: "UBOT" },
            { ts: "100.3", text: "?진짜 질문", user: "U1" },
          ],
        }),
        "chat.postMessage": () => ({ ok: true, ts: "999.1" }),
      },
      calls
    );

    const dispatchCalls: Array<{ question: string; mode: string }> = [];
    const askDispatch: AskDispatch = async (question, mode) => {
      dispatchCalls.push({ question, mode });
      return makeEnvelope({ answer: "답변입니다" });
    };

    const bridge = makeBridge(fetchImpl, dataDir, askDispatch);
    await bridge.poll();

    assert.equal(dispatchCalls.length, 1, "실제 사용자의 질문 1건만 처리되어야 한다");
    assert.equal(dispatchCalls[0].question, "진짜 질문");

    const postCalls = calls.filter((c) => c.method === "chat.postMessage");
    assert.equal(postCalls.length, 1);
    assert.equal(postCalls[0].body.thread_ts, "100.3");
    assert.equal(postCalls[0].body.channel, "C1");
    assert.equal(postCalls[0].body.text, "답변입니다");

    const state = JSON.parse(await readFile(path.join(dataDir, "slack-ask.state.json"), "utf8"));
    assert.equal(state["C1"], "100.3", "마지막으로 처리된 메시지 ts까지 상태가 진행되어야 한다");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("초대 매핑이 없는 사용자에게는 안내 메시지를 답장하고 상태를 진행한다", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cosmos-slackask-"));
  try {
    await writeState(dataDir, { C2: "200.0" });

    const calls: SlackCall[] = [];
    const fetchImpl = makeFetch(
      {
        "conversations.list": () => ({ ok: true, channels: [{ id: "C2", user: "U-unknown" }] }),
        "auth.test": () => ({ ok: true, user_id: "UBOT" }),
        "conversations.history": () => ({ ok: true, messages: [{ ts: "200.2", text: "?안녕", user: "U-unknown" }] }),
        "chat.postMessage": () => ({ ok: true, ts: "999.2" }),
      },
      calls
    );

    const dispatchCalls: unknown[] = [];
    const askDispatch: AskDispatch = async () => {
      dispatchCalls.push(1);
      return makeEnvelope();
    };

    const bridge = makeBridge(fetchImpl, dataDir, askDispatch);
    await bridge.poll();

    assert.equal(dispatchCalls.length, 0, "매핑되지 않은 사용자의 질문은 ask 파이프라인을 타지 않는다");
    const postCalls = calls.filter((c) => c.method === "chat.postMessage");
    assert.equal(postCalls.length, 1);
    assert.match(String(postCalls[0].body.text), /코스모스 계정이 없습니다/);
    assert.equal(postCalls[0].body.thread_ts, "200.2");

    const state = JSON.parse(await readFile(path.join(dataDir, "slack-ask.state.json"), "utf8"));
    assert.equal(state["C2"], "200.2", "안내만 보내고도 상태는 진행되어야 한다");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("한 채널의 Slack API 실패는 다른 채널 처리를 막지 않고, ask 파이프라인 오류는 오류 메시지로 답장하며 기록된다", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cosmos-slackask-"));
  try {
    await writeInvite(dataDir, "bob", "U-bob");
    await addUser("bob", "member", dataDir);
    await writeState(dataDir, { "C-fail": "1.0", "C-ok": "2.0" });

    const calls: SlackCall[] = [];
    const fetchImpl = makeFetch(
      {
        "conversations.list": () => ({
          ok: true,
          channels: [
            { id: "C-fail", user: "U-x" },
            { id: "C-ok", user: "U-bob" },
          ],
        }),
        "auth.test": () => ({ ok: true, user_id: "UBOT" }),
        "conversations.history": (body) => {
          if (body.channel === "C-fail") return { ok: false, error: "forced_failure" };
          return { ok: true, messages: [{ ts: "2.1", text: "?터지는 질문", user: "U-bob" }] };
        },
        "chat.postMessage": () => ({ ok: true, ts: "999.3" }),
      },
      calls
    );

    const askDispatch: AskDispatch = async () => {
      throw new Error("파이프라인 실패");
    };

    const bridge = makeBridge(fetchImpl, dataDir, askDispatch);
    await assert.doesNotReject(bridge.poll(), "poll()은 절대 throw하지 않아야 한다");

    const postCalls = calls.filter((c) => c.method === "chat.postMessage" && c.body.channel === "C-ok");
    assert.equal(postCalls.length, 1);
    assert.match(String(postCalls[0].body.text), /오류가 발생했습니다/);
    assert.match(String(postCalls[0].body.text), /파이프라인 실패/);

    const state = JSON.parse(await readFile(path.join(dataDir, "slack-ask.state.json"), "utf8"));
    assert.equal(state["C-ok"], "2.1", "오류가 나도 처리된 메시지로 상태는 진행되어야 한다");
    assert.equal(state["C-fail"], "1.0", "실패한 채널은 상태가 그대로 유지되어야 한다");

    const askLog = (await readFile(path.join(dataDir, "ask-log.jsonl"), "utf8")).trim();
    const logLine = JSON.parse(askLog.split("\n").pop()!);
    assert.equal(logLine.client, "slack");
    assert.equal(logLine.error, true);
    assert.equal(logLine.user, "bob");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("정상 처리 시 질문 스레드에 답장하고 출처 목록을 포함하며 ask-log에 client=slack으로 기록한다", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cosmos-slackask-"));
  try {
    await writeInvite(dataDir, "carol", "U-carol");
    await addUser("carol", "member", dataDir);
    await writeState(dataDir, { C3: "3.0" });

    const calls: SlackCall[] = [];
    const fetchImpl = makeFetch(
      {
        "conversations.list": () => ({ ok: true, channels: [{ id: "C3", user: "U-carol" }] }),
        "auth.test": () => ({ ok: true, user_id: "UBOT" }),
        "conversations.history": () => ({ ok: true, messages: [{ ts: "3.1", text: "??깊은 질문", user: "U-carol" }] }),
        "chat.postMessage": () => ({ ok: true, ts: "999.4" }),
      },
      calls
    );

    const envelope = makeEnvelope({
      answer: "심층 답변",
      mode: "deep",
      sources: [{ n: 1, origin: "doc-a", title: "문서A", chunk_id: "c1", char_start: 0, char_end: 5 }],
    });
    const dispatchCalls: Array<{ question: string; mode: string }> = [];
    const askDispatch: AskDispatch = async (question, mode) => {
      dispatchCalls.push({ question, mode });
      return envelope;
    };

    const bridge = makeBridge(fetchImpl, dataDir, askDispatch);
    await bridge.poll();

    assert.equal(dispatchCalls.length, 1);
    assert.equal(dispatchCalls[0].question, "깊은 질문");
    assert.equal(dispatchCalls[0].mode, "deep", "'??'는 강제로 deep 모드가 되어야 한다");

    const postCalls = calls.filter((c) => c.method === "chat.postMessage");
    assert.equal(postCalls.length, 1);
    assert.equal(postCalls[0].body.thread_ts, "3.1", "질문 메시지의 ts로 스레드 답장해야 한다");
    assert.equal(postCalls[0].body.text, formatSlackReply(envelope));
    assert.match(String(postCalls[0].body.text), /문서A — doc-a/);

    const askLog = (await readFile(path.join(dataDir, "ask-log.jsonl"), "utf8")).trim();
    const logLine = JSON.parse(askLog);
    assert.equal(logLine.client, "slack");
    assert.equal(logLine.user, "carol");
    assert.equal(logLine.mode, "deep");
    assert.equal(logLine.insufficient, false);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
