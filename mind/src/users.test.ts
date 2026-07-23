import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { addUser, resolveIdentity, loadUsers } from "./users.js";

test("resolveIdentity는 first_used_at을 write-once로 기록한다(2회 인증에 1회만 기록)", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cosmos-users-"));
  const prevToken = process.env.COSMOS_TOKEN;
  process.env.COSMOS_TOKEN = "bootstrap-secret-for-test";
  try {
    const token = await addUser("alice", "member", dataDir);

    const first = await resolveIdentity(token, dataDir);
    assert.equal(first?.name, "alice");
    const afterFirst = await loadUsers(dataDir);
    assert.equal(afterFirst.length, 1);
    const firstStamp = afterFirst[0].first_used_at;
    assert.ok(firstStamp, "첫 인증 후 first_used_at이 기록되어야 한다");

    const second = await resolveIdentity(token, dataDir);
    assert.equal(second?.name, "alice");
    const afterSecond = await loadUsers(dataDir);
    assert.equal(afterSecond[0].first_used_at, firstStamp, "재인증 시 first_used_at이 갱신되면 안 된다(write-once)");

    // Bootstrap admin (env COSMOS_TOKEN) auth is not tracked -- no admin record gets created in users.json.
    const adminIdentity = await resolveIdentity("bootstrap-secret-for-test", dataDir);
    assert.equal(adminIdentity?.name, "admin");
    const afterAdmin = await loadUsers(dataDir);
    assert.equal(afterAdmin.length, 1, "부트스트랩 admin은 users.json에 기록되지 않는다");
  } finally {
    process.env.COSMOS_TOKEN = prevToken;
    await rm(dataDir, { recursive: true, force: true });
  }
});
