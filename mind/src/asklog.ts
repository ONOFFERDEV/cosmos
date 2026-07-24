// Ask usage instrumentation: appends one JSON line per /ask (or /ask/stream) call to
// data/ask-log.jsonl, and aggregates it for GET /stats. See CLAUDE.md's mind module map.
// Distinct from ask.ts's queries.jsonl (per-question trace/cost detail for debugging) —
// this log is usage/adoption metrics only (mode, user, client, latency).

import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface AskLogRecord {
  ts: string;
  mode: string;
  user: string;
  client: string;
  ms: number;
  insufficient: boolean;
  error?: true;
  /** Question text truncated to 120 chars (avoids bloating the log with long questions). */
  q: string;
}

export interface AskStatsDay {
  date: string;
  count: number;
  modes: Record<string, number>;
  clients: Record<string, number>;
  users: Record<string, number>;
}

export interface AskStats {
  total: number;
  days: AskStatsDay[];
  recent: AskLogRecord[];
}

function askLogPath(dataDir: string): string {
  return path.join(dataDir, "ask-log.jsonl");
}

/**
 * Appends one usage record. Must never throw and never block the caller's response path —
 * callers should invoke this without awaiting (fire-and-forget), and this function swallows
 * every failure itself (disk full, missing dir, etc.) so a logging problem can never affect
 * an /ask response.
 */
export async function appendAskLog(dataDir: string, record: AskLogRecord): Promise<void> {
  try {
    await mkdir(dataDir, { recursive: true });
    const line = JSON.stringify({ ...record, q: record.q.slice(0, 120) });
    await appendFile(askLogPath(dataDir), line + "\n", "utf8");
  } catch (err) {
    console.warn(`ask-log 기록 실패: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

/** Reads and aggregates ask-log.jsonl. Tolerates corrupt/partial lines (skips them) — a single
 * bad line (e.g. from a crash mid-write) must never break the whole /stats response. */
export async function readAskStats(dataDir: string): Promise<AskStats> {
  let raw: string;
  try {
    raw = await readFile(askLogPath(dataDir), "utf8");
  } catch {
    return { total: 0, days: [], recent: [] };
  }

  const records: AskLogRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<AskLogRecord>;
      if (!parsed.ts || !parsed.mode || !parsed.user || !parsed.client) continue;
      records.push({
        ts: parsed.ts,
        mode: parsed.mode,
        user: parsed.user,
        client: parsed.client,
        ms: typeof parsed.ms === "number" ? parsed.ms : 0,
        insufficient: Boolean(parsed.insufficient),
        ...(parsed.error ? { error: true as const } : {}),
        q: typeof parsed.q === "string" ? parsed.q : "",
      });
    } catch {
      // Corrupt line — skip it and keep going.
    }
  }

  const byDay = new Map<string, AskStatsDay>();
  for (const rec of records) {
    const date = rec.ts.slice(0, 10);
    let day = byDay.get(date);
    if (!day) {
      day = { date, count: 0, modes: {}, clients: {}, users: {} };
      byDay.set(date, day);
    }
    day.count += 1;
    bump(day.modes, rec.mode);
    bump(day.clients, rec.client);
    bump(day.users, rec.user);
  }

  const days = Array.from(byDay.values())
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .slice(0, 30);

  const recent = records
    .slice()
    .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
    .slice(0, 20);

  return { total: records.length, days, recent };
}
