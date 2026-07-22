// 자기소멸 초대 봇. CONTRACT.md "# M8.5 확장" 참고.
// data/invites.json: [{name, slack_user, channel, ts, sent_at, status}].
// env SLACK_BOT_TOKEN 미설정 = 초대 봇 기능 전체 비활성(sendInvite는 계정만 만들고 토큰을 반환,
// checkInvites는 아무 것도 하지 않는다). env COSMOS_PUBLIC_URL = 초대 링크 베이스
// (기본 http://localhost:8800 — 실배포 주소는 env가 정한다).

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { defaultDataDir } from "./config.js";
import { addUser, loadUsers, type Role } from "./users.js";

const DEFAULT_PUBLIC_URL = "http://localhost:8800";

function publicUrl(): string {
  return process.env.COSMOS_PUBLIC_URL || DEFAULT_PUBLIC_URL;
}
const EXPIRE_MS = 72 * 60 * 60 * 1000;

export type InviteStatus = "pending" | "done" | "expired";

export interface InviteRecord {
  name: string;
  slack_user: string;
  channel: string;
  ts: string;
  sent_at: string;
  status: InviteStatus;
}

export interface InviteDeps {
  fetchImpl?: typeof fetch;
  dataDir?: string;
  now?: () => number;
}

export interface SendInviteResult {
  token: string;
  delivered: boolean;
}

interface SlackApiResponse {
  ok: boolean;
  error?: string;
  channel?: { id: string };
  ts?: string;
}

function invitesPath(dataDir: string): string {
  return path.join(dataDir, "invites.json");
}

async function loadInvites(dataDir: string): Promise<InviteRecord[]> {
  try {
    const raw = await readFile(invitesPath(dataDir), "utf8");
    return JSON.parse(raw) as InviteRecord[];
  } catch {
    return [];
  }
}

async function saveInvites(dataDir: string, invites: InviteRecord[]): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(invitesPath(dataDir), JSON.stringify(invites, null, 2), "utf8");
}

async function callSlack(
  method: string,
  body: Record<string, unknown>,
  token: string,
  fetchImpl: typeof fetch
): Promise<SlackApiResponse> {
  const res = await fetchImpl(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as SlackApiResponse;
  if (!res.ok || !json.ok) {
    throw new Error(`slack ${method} 실패: ${json.error ?? res.status}`);
  }
  return json;
}

function buildInviteText(link: string): string {
  return `🪐 온오퍼 지식 코스모스 초대 — 아래 링크를 사내 네트워크에서 클릭하면 바로 사용됩니다\n${link}\n(본인 전용 · 인증되면 이 메시지는 자동 삭제됩니다)`;
}

/**
 * 새 사용자를 만들고(addUser 재사용) 슬랙 DM으로 초대 링크를 발송한다. SLACK_BOT_TOKEN이
 * 없거나 슬랙 호출(conversations.open/chat.postMessage)이 실패하면 계정은 그대로 유지한 채
 * 토큰을 반환한다 — 호출부가 수동 전달 폴백을 안내해야 한다. 이 경우 invites.json에는
 * 기록하지 않는다(발송되지 않은 메시지를 추적 대상으로 남기지 않기 위함).
 */
export async function sendInvite(
  name: string,
  slackUserId: string,
  role: Role = "member",
  deps: InviteDeps = {}
): Promise<SendInviteResult> {
  const dataDir = deps.dataDir ?? defaultDataDir();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());

  const token = await addUser(name, role, dataDir);

  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!botToken) {
    return { token, delivered: false };
  }

  try {
    const link = `${publicUrl()}/#token=${token}`;
    const opened = await callSlack("conversations.open", { users: slackUserId }, botToken, fetchImpl);
    const channelId = opened.channel?.id;
    if (!channelId) {
      throw new Error("slack conversations.open 응답에 channel.id 없음");
    }
    const posted = await callSlack(
      "chat.postMessage",
      { channel: channelId, text: buildInviteText(link) },
      botToken,
      fetchImpl
    );
    const invites = await loadInvites(dataDir);
    invites.push({
      name,
      slack_user: slackUserId,
      channel: channelId,
      ts: posted.ts ?? "",
      sent_at: new Date(now()).toISOString(),
      status: "pending",
    });
    await saveInvites(dataDir, invites);
    return { token, delivered: true };
  } catch {
    return { token, delivered: false };
  }
}

/**
 * pending 초대를 순회해 ①첫 인증 완료(users.json의 first_used_at) ②72h 경과(미인증) 여부를
 * 판정하고, 슬랙 DM을 삭제한 뒤 후속 안내 DM을 보내 상태를 done|expired로 전이시킨다.
 * 슬랙 호출 실패는 상태를 건드리지 않아 다음 주기에 재시도된다. SLACK_BOT_TOKEN 미설정이면
 * 아무 것도 하지 않는다.
 */
export async function checkInvites(deps: InviteDeps = {}): Promise<void> {
  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!botToken) return;

  const dataDir = deps.dataDir ?? defaultDataDir();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());

  const invites = await loadInvites(dataDir);
  const pending = invites.filter((i) => i.status === "pending");
  if (pending.length === 0) return;

  const users = await loadUsers(dataDir);
  let changed = false;

  for (const invite of pending) {
    const user = users.find((u) => u.name === invite.name);
    const verified = Boolean(user?.first_used_at);
    const expired = !verified && now() - Date.parse(invite.sent_at) >= EXPIRE_MS;
    if (!verified && !expired) continue;

    try {
      await callSlack("chat.delete", { channel: invite.channel, ts: invite.ts }, botToken, fetchImpl);
      await callSlack(
        "chat.postMessage",
        {
          channel: invite.channel,
          text: verified
            ? `✅ 인증 확인 — 보안을 위해 초대 링크를 삭제했어요\n\n📝 내 개인 지식(선택): 쓰는 AI(클로드 코드 등)에게 이 한 줄만 주세요\n> ${publicUrl()}/web/kit/AI-SETUP.md 읽고 내 지식 레포 세팅해줘 (내 코스모스 토큰: 위 링크의 것)\nAI가 레포 생성→코스모스 연결→검증까지 해 줍니다. 이후엔 레포에 .md 노트를 쓰면 자동으로 내 개인 공간에 반영돼요(나에게만 보임 · PC 설치물 0)`
            : "⏰ 초대 링크 만료 — 관리자에게 재발급을 요청하세요",
        },
        botToken,
        fetchImpl
      );
      invite.status = verified ? "done" : "expired";
      changed = true;
    } catch {
      // 슬랙 호출 실패 — 상태 불변, 다음 주기 재시도.
    }
  }

  if (changed) {
    await saveInvites(dataDir, invites);
  }
}
