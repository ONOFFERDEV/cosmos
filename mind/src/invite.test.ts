import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { sendInvite, checkInvites } from "./invite.js";
import { loadUsers, resolveIdentity } from "./users.js";

interface SlackCall {
  method: string;
  body: Record<string, unknown>;
}

function makeSlackFetch(responses: Record<string, Record<string, unknown>>, calls: SlackCall[]): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const method = url.toString().replace("https://slack.com/api/", "");
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
    calls.push({ method, body });
    const payload = responses[method] ?? { ok: false, error: "not_mocked" };
    return { ok: true, json: async () => payload } as unknown as Response;
  }) as unknown as typeof fetch;
}

test("sendInvite는 conversations.open→chat.postMessage 순으로 호출하고 invites.json에 pending으로 기록한다", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cosmos-invite-"));
  const calls: SlackCall[] = [];
  const fetchImpl = makeSlackFetch(
    {
      "conversations.open": { ok: true, channel: { id: "C123" } },
      "chat.postMessage": { ok: true, ts: "1700000000.000100" },
    },
    calls
  );
  const prevSlack = process.env.SLACK_BOT_TOKEN;
  const prevUrl = process.env.COSMOS_PUBLIC_URL;
  process.env.SLACK_BOT_TOKEN = "xoxb-test";
  delete process.env.COSMOS_PUBLIC_URL;
  try {
    const result = await sendInvite("bob", "U999", "member", {
      dataDir,
      fetchImpl,
      now: () => Date.parse("2026-07-15T00:00:00Z"),
    });
    assert.equal(result.delivered, true);
    assert.ok(result.token);

    assert.equal(calls.length, 2);
    assert.equal(calls[0].method, "conversations.open");
    assert.deepEqual(calls[0].body, { users: "U999" });
    assert.equal(calls[1].method, "chat.postMessage");
    assert.equal(calls[1].body.channel, "C123");
    // Default public address is a neutral value (localhost) — the real deployment address is set via env COSMOS_PUBLIC_URL (productization convention).
    assert.match(String(calls[1].body.text), /http:\/\/localhost:8800\/#token=/);

    const invites = JSON.parse(await readFile(path.join(dataDir, "invites.json"), "utf8"));
    assert.equal(invites.length, 1);
    assert.equal(invites[0].name, "bob");
    assert.equal(invites[0].slack_user, "U999");
    assert.equal(invites[0].channel, "C123");
    assert.equal(invites[0].status, "pending");
  } finally {
    process.env.SLACK_BOT_TOKEN = prevSlack;
    process.env.COSMOS_PUBLIC_URL = prevUrl;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("conversations.open 실패 시 sendInvite는 계정을 유지한 채 토큰을 반환하고 invites.json에 기록하지 않는다", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cosmos-invite-"));
  const calls: SlackCall[] = [];
  const fetchImpl = makeSlackFetch({ "conversations.open": { ok: false, error: "channel_not_found" } }, calls);
  const prevSlack = process.env.SLACK_BOT_TOKEN;
  process.env.SLACK_BOT_TOKEN = "xoxb-test";
  try {
    const result = await sendInvite("carol", "U000", "member", { dataDir, fetchImpl });
    assert.equal(result.delivered, false);
    assert.ok(result.token);

    const users = await loadUsers(dataDir);
    assert.equal(users.length, 1);
    assert.equal(users[0].name, "carol");

    await assert.rejects(readFile(path.join(dataDir, "invites.json"), "utf8"));
  } finally {
    process.env.SLACK_BOT_TOKEN = prevSlack;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("checkInvites는 인증됨→done, 72h경과→expired, 그 외→무동작으로 분기한다", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cosmos-invite-"));
  const HOUR = 60 * 60 * 1000;
  const T0 = Date.parse("2026-07-15T00:00:00Z");

  const setupCalls: SlackCall[] = [];
  const setupFetch = makeSlackFetch(
    {
      "conversations.open": { ok: true, channel: { id: "C-open" } },
      "chat.postMessage": { ok: true, ts: "1.1" },
    },
    setupCalls
  );

  const prevSlack = process.env.SLACK_BOT_TOKEN;
  const prevToken = process.env.COSMOS_TOKEN;
  process.env.SLACK_BOT_TOKEN = "xoxb-test";
  process.env.COSMOS_TOKEN = "bootstrap-secret-for-test";
  try {
    const verified = await sendInvite("verified-user", "U1", "member", {
      dataDir,
      fetchImpl: setupFetch,
      now: () => T0 - 1 * HOUR,
    });
    const expired = await sendInvite("expired-user", "U2", "member", {
      dataDir,
      fetchImpl: setupFetch,
      now: () => T0 - 73 * HOUR,
    });
    const recent = await sendInvite("recent-user", "U3", "member", {
      dataDir,
      fetchImpl: setupFetch,
      now: () => T0 - 1 * HOUR,
    });
    assert.ok(verified.delivered && expired.delivered && recent.delivered);

    // Simulate real authentication so only verified-user gets first_used_at recorded (write-once reuse).
    await resolveIdentity(verified.token, dataDir);

    const checkCalls: SlackCall[] = [];
    const checkFetch = makeSlackFetch(
      {
        "chat.delete": { ok: true },
        "chat.postMessage": { ok: true, ts: "2.2" },
      },
      checkCalls
    );

    await checkInvites({ dataDir, fetchImpl: checkFetch, now: () => T0 });

    const invites = JSON.parse(await readFile(path.join(dataDir, "invites.json"), "utf8")) as Array<{
      name: string;
      status: string;
      channel: string;
    }>;
    const byName = Object.fromEntries(invites.map((i) => [i.name, i]));
    assert.equal(byName["verified-user"].status, "done");
    assert.equal(byName["expired-user"].status, "expired");
    assert.equal(byName["recent-user"].status, "pending");

    const deleteCalls = checkCalls.filter((c) => c.method === "chat.delete");
    assert.equal(deleteCalls.length, 2, "인증됨+만료 2건만 삭제되어야 한다(미인증·미만료는 무동작)");
    const deletedChannels = deleteCalls.map((c) => c.body.channel).sort();
    assert.deepEqual(deletedChannels, [byName["expired-user"].channel, byName["verified-user"].channel].sort());

    const postTexts = checkCalls.filter((c) => c.method === "chat.postMessage").map((c) => String(c.body.text));
    assert.ok(postTexts.some((t) => t.includes("인증 확인")));
    assert.ok(postTexts.some((t) => t.includes("만료")));
  } finally {
    process.env.SLACK_BOT_TOKEN = prevSlack;
    process.env.COSMOS_TOKEN = prevToken;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("SLACK_BOT_TOKEN 미설정 시 checkInvites는 아무 것도 하지 않는다", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cosmos-invite-"));
  const calls: SlackCall[] = [];
  const fetchImpl = makeSlackFetch({}, calls);
  const prevSlack = process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_BOT_TOKEN;
  try {
    await checkInvites({ dataDir, fetchImpl });
    assert.equal(calls.length, 0);
  } finally {
    process.env.SLACK_BOT_TOKEN = prevSlack;
    await rm(dataDir, { recursive: true, force: true });
  }
});
