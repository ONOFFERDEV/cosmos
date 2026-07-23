// mind user/role management. See CONTRACT.md's M8 extension section "mind: 사용자·역할".
// data/users.json: [{name, role, token_sha256, created_at, revoked_at?}].
// env COSMOS_TOKEN = bootstrap admin (name="admin"). Unset env = local dev mode (everyone is
// admin, preserving the existing public auth convention).
// Plaintext tokens are never stored — only the sha256 hash is kept.

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
 * Determines identity from the bearer token.
 * If env COSMOS_TOKEN is unset, it's local dev mode — everyone resolves to admin regardless
 * of whether a token is present (preserving the existing isTokenValid "!token → true" public
 * convention up through the identity layer).
 * If it is set: an exact match against the env token -> bootstrap admin. Otherwise, look up a
 * non-revoked user in users.json whose sha256 hash matches. If none is found, return null (the
 * caller handles it as a 401).
 * If the matched user's first_used_at is empty, record it write-once (if already set, the file
 * is not rewritten — avoids a disk write on every request). The bootstrap admin is excluded
 * from this tracking.
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

/** Adds a new user and returns the plaintext token (this return value is the only exposure opportunity — only the hash is kept afterward). */
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

/** User list excluding the token hash (for list display — the token is never exposed). */
export async function listUsers(dataDir: string = defaultDataDir()): Promise<Omit<User, "token_sha256">[]> {
  const users = await loadUsers(dataDir);
  return users.map((u) => ({
    name: u.name,
    role: u.role,
    created_at: u.created_at,
    ...(u.revoked_at ? { revoked_at: u.revoked_at } : {}),
  }));
}

/** Revokes a user (keeps the record, only sets revoked_at). Returns false if not found. */
export async function revokeUser(name: string, dataDir: string = defaultDataDir()): Promise<boolean> {
  const users = await loadUsers(dataDir);
  const idx = users.findIndex((u) => u.name === name);
  if (idx === -1) return false;
  users[idx] = { ...users[idx], revoked_at: new Date().toISOString() };
  await saveUsers(dataDir, users);
  return true;
}
