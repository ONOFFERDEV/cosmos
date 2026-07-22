// mind 사용자·역할 관리. CONTRACT.md M8 확장 절 "mind: 사용자·역할" 참고.
// data/users.json: [{name, role, token_sha256, created_at, revoked_at?}].
// env COSMOS_TOKEN = 부트스트랩 관리자(name="admin"). env 미설정 = 로컬 개발 모드(전부 admin, 기존 인증 공개 규약 유지).
// 평문 토큰은 저장하지 않는다 — sha256 해시만 보관.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";

import { defaultDataDir } from "./config.js";

export type Role = "admin" | "member";

export interface User {
  name: string;
  role: Role;
  token_sha256: string;
  created_at: string;
  revoked_at?: string;
  first_used_at?: string;
}

export interface Identity {
  name: string;
  role: Role;
}

function usersPath(dataDir: string): string {
  return path.join(dataDir, "users.json");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function loadUsers(dataDir: string = defaultDataDir()): Promise<User[]> {
  try {
    const raw = await readFile(usersPath(dataDir), "utf8");
    return JSON.parse(raw) as User[];
  } catch {
    return [];
  }
}

async function saveUsers(dataDir: string, users: User[]): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(usersPath(dataDir), JSON.stringify(users, null, 2), "utf8");
}

/**
 * Bearer 토큰으로 identity를 판정한다.
 * env COSMOS_TOKEN이 비어 있으면 로컬 개발 모드 — 토큰 유무와 무관하게 admin(기존 isTokenValid의
 * "!token → true" 공개 규약을 identity 계층까지 유지).
 * 설정돼 있으면: env 토큰과 정확히 일치 -> 부트스트랩 admin. 아니면 users.json에서 sha256 해시가
 * 일치하고 revoked_at이 없는 사용자를 찾는다. 찾지 못하면 null(호출부에서 401 처리).
 * 매치된 사용자의 first_used_at이 비어 있으면 write-once로 기록한다(이미 있으면 파일을
 * 다시 쓰지 않는다 — 매 요청 디스크 쓰기 방지). 부트스트랩 admin은 기록 대상이 아니다.
 */
export async function resolveIdentity(
  bearerToken: string | null,
  dataDir: string = defaultDataDir()
): Promise<Identity | null> {
  const envToken = process.env.COSMOS_TOKEN;
  if (!envToken) {
    return { name: "admin", role: "admin" };
  }
  if (!bearerToken) return null;
  if (bearerToken === envToken) {
    return { name: "admin", role: "admin" };
  }
  const hash = hashToken(bearerToken);
  const users = await loadUsers(dataDir);
  const idx = users.findIndex((u) => u.token_sha256 === hash && !u.revoked_at);
  if (idx === -1) return null;
  const match = users[idx];
  if (!match.first_used_at) {
    users[idx] = { ...match, first_used_at: new Date().toISOString() };
    await saveUsers(dataDir, users);
  }
  return { name: match.name, role: match.role };
}

/** 새 사용자를 추가하고 평문 토큰을 반환한다(이 반환값이 유일한 노출 기회 — 이후로는 해시만 보관). */
export async function addUser(name: string, role: Role, dataDir: string = defaultDataDir()): Promise<string> {
  const users = await loadUsers(dataDir);
  if (users.some((u) => u.name === name)) {
    throw new Error(`이미 존재하는 사용자입니다: ${name}`);
  }
  const token = randomBytes(32).toString("hex");
  users.push({
    name,
    role,
    token_sha256: hashToken(token),
    created_at: new Date().toISOString(),
  });
  await saveUsers(dataDir, users);
  return token;
}

/** 토큰 해시를 제외한 사용자 목록(list 표시용 — 토큰은 절대 노출하지 않는다). */
export async function listUsers(dataDir: string = defaultDataDir()): Promise<Omit<User, "token_sha256">[]> {
  const users = await loadUsers(dataDir);
  return users.map((u) => ({
    name: u.name,
    role: u.role,
    created_at: u.created_at,
    ...(u.revoked_at ? { revoked_at: u.revoked_at } : {}),
  }));
}

/** 사용자를 폐기한다(레코드는 유지, revoked_at만 설정). 존재하지 않으면 false. */
export async function revokeUser(name: string, dataDir: string = defaultDataDir()): Promise<boolean> {
  const users = await loadUsers(dataDir);
  const idx = users.findIndex((u) => u.name === name);
  if (idx === -1) return false;
  users[idx] = { ...users[idx], revoked_at: new Date().toISOString() };
  await saveUsers(dataDir, users);
  return true;
}
