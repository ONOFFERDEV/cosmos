// Approval inbox: loads/renders the pending list, approve (calls core /ingest then moves to
// approved/), reject (moves to rejected/). See CONTRACT.md M2 extension section's "approval gate".
// Never calls core /ingest before approve.

import { readdir, readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import path from "node:path";

import type { CoreClient } from "./core-client.js";
import type { PendingCandidate } from "./collect.js";
import { defaultDataDir } from "./config.js";

export interface DecidedCandidate extends Omit<PendingCandidate, "status"> {
  status: "approved" | "rejected";
  decided_at: string;
  decision: "approved" | "rejected";
  cluster_slug?: string | null;
  fit?: number | null;
}

export interface InboxDeps {
  core: CoreClient;
  dataDir?: string;
}

function inboxDir(dataDir: string, sub: "pending" | "approved" | "rejected"): string {
  return path.join(dataDir, "inbox", sub);
}

export async function listPending(dataDir?: string): Promise<PendingCandidate[]> {
  const dir = inboxDir(dataDir ?? defaultDataDir(), "pending");
  let files: string[] = [];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const jsonFiles = files.filter((f) => f.endsWith(".json")).sort();
  const items: PendingCandidate[] = [];
  for (const f of jsonFiles) {
    try {
      const raw = await readFile(path.join(dir, f), "utf8");
      items.push(JSON.parse(raw) as PendingCandidate);
    } catch {
      // Skip corrupted files.
    }
  }
  return items;
}

export function renderPendingTable(items: PendingCandidate[]): string {
  if (items.length === 0) return "대기 중인 후보가 없습니다.";
  return items
    .map((c) => `${c.id}  [${c.source_type}]  score=${c.score.toFixed(1)}  ${c.title}`)
    .join("\n");
}

export interface ApproveResult {
  id: string;
  ok: boolean;
  error?: string;
}

async function readPending(dataDir: string, id: string): Promise<PendingCandidate | null> {
  try {
    const raw = await readFile(path.join(inboxDir(dataDir, "pending"), `${id}.json`), "utf8");
    return JSON.parse(raw) as PendingCandidate;
  } catch {
    return null;
  }
}

export async function approveOne(id: string, deps: InboxDeps): Promise<ApproveResult> {
  const dataDir = deps.dataDir ?? defaultDataDir();
  const candidate = await readPending(dataDir, id);
  if (!candidate) {
    return { id, ok: false, error: "pending 파일을 찾을 수 없습니다." };
  }

  let ingestedInfo: { cluster_slug?: string | null; fit?: number | null } = {};
  try {
    const response = await deps.core.ingest({
      docs: [
        {
          origin: candidate.origin,
          source_type: candidate.source_type,
          title: candidate.title,
          text: candidate.text,
        },
      ],
    });
    const ingested = response.ingested[0];
    if (ingested) {
      ingestedInfo = { cluster_slug: ingested.cluster_slug ?? null, fit: ingested.fit ?? null };
    }
  } catch (err) {
    return { id, ok: false, error: (err as Error).message };
  }

  const decided: DecidedCandidate = {
    ...candidate,
    status: "approved",
    decided_at: new Date().toISOString(),
    decision: "approved",
    cluster_slug: ingestedInfo.cluster_slug ?? null,
    fit: ingestedInfo.fit ?? null,
  };

  const approvedDir = inboxDir(dataDir, "approved");
  await mkdir(approvedDir, { recursive: true });
  await writeFile(path.join(approvedDir, `${id}.json`), JSON.stringify(decided, null, 2), "utf8");
  await unlink(path.join(inboxDir(dataDir, "pending"), `${id}.json`));

  return { id, ok: true };
}

export async function rejectOne(id: string, deps: { dataDir?: string }): Promise<ApproveResult> {
  const dataDir = deps.dataDir ?? defaultDataDir();
  const candidate = await readPending(dataDir, id);
  if (!candidate) {
    return { id, ok: false, error: "pending 파일을 찾을 수 없습니다." };
  }

  const decided: DecidedCandidate = {
    ...candidate,
    status: "rejected",
    decided_at: new Date().toISOString(),
    decision: "rejected",
  };

  const rejectedDir = inboxDir(dataDir, "rejected");
  await mkdir(rejectedDir, { recursive: true });
  await writeFile(path.join(rejectedDir, `${id}.json`), JSON.stringify(decided, null, 2), "utf8");
  await unlink(path.join(inboxDir(dataDir, "pending"), `${id}.json`));

  return { id, ok: true };
}

export async function approveMany(ids: string[], deps: InboxDeps): Promise<ApproveResult[]> {
  const results: ApproveResult[] = [];
  for (const id of ids) {
    results.push(await approveOne(id, deps));
  }
  return results;
}

export async function rejectMany(ids: string[], deps: { dataDir?: string }): Promise<ApproveResult[]> {
  const results: ApproveResult[] = [];
  for (const id of ids) {
    results.push(await rejectOne(id, deps));
  }
  return results;
}

export async function approveAll(deps: InboxDeps): Promise<ApproveResult[]> {
  const pending = await listPending(deps.dataDir);
  return approveMany(pending.map((c) => c.id), deps);
}
