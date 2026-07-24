// Slack DM ask bridge. Polls each DM channel for messages prefixed with "?" (auto mode) or "??"
// (forced deep mode), resolves the sender's cosmos identity via invites.json + users.json, runs
// the same ask pipeline the HTTP /ask endpoint uses, and replies in-thread with the answer plus
// up to a few sources. Started from cron.ts's startCronJobs, gated on SLACK_BOT_TOKEN being set
// and env COSMOS_SLACK_ASK !== "0". Reuses invite.ts's callSlack helper (raw fetch to the Slack
// Web API) and server.ts's exported ask dispatch (resolveAskMode/runAskPipeline/ownerScopeFor) so
// HTTP and Slack answer questions through the exact same code path.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import type { CoreClient } from "./core-client.js";
import type { LlmClient } from "./llm.js";
import { defaultDataDir } from "./config.js";
import { loadInvites, callSlack } from "./invite.js";
import { loadUsers, type Identity } from "./users.js";
import { resolveAskMode, runAskPipeline, ownerScopeFor, type AskMode, type ServerDeps } from "./server.js";
import { appendAskLog } from "./asklog.js";
import type { AskEnvelope } from "./envelope.js";

const DEFAULT_INTERVAL_S = 20;
const CHANNEL_LIST_TTL_MS = 10 * 60 * 1000;
const MAX_SOURCES = 5;
const MAX_REPLY_CHARS = 3500;
const UNKNOWN_USER_REPLY = "코스모스 계정이 없습니다. 관리자에게 초대를 요청해 주세요.";

export interface SlackAskDeps {
  core: CoreClient;
  llm: LlmClient;
  token: string;
  dataDir?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface SlackMessage {
  ts: string;
  text?: string;
  user?: string;
  bot_id?: string;
}

interface SlackChannel {
  id: string;
  /** DM partner's Slack user id. */
  user?: string;
}

type SlackAskState = Record<string, string>;

export type AskDispatch = (question: string, mode: AskMode, deps: SlackAskDeps, identity: Identity) => Promise<AskEnvelope>;

async function defaultAskDispatch(question: string, mode: AskMode, deps: SlackAskDeps, identity: Identity): Promise<AskEnvelope> {
  const serverDeps: ServerDeps = { core: deps.core, llm: deps.llm, dataDir: deps.dataDir, fetchImpl: deps.fetchImpl };
  return runAskPipeline(question, mode, serverDeps, undefined, ownerScopeFor(identity));
}

function statePath(dataDir: string): string {
  return path.join(dataDir, "slack-ask.state.json");
}

async function loadState(dataDir: string): Promise<SlackAskState> {
  try {
    const raw = await readFile(statePath(dataDir), "utf8");
    return JSON.parse(raw) as SlackAskState;
  } catch {
    return {};
  }
}

async function saveState(dataDir: string, state: SlackAskState): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(statePath(dataDir), JSON.stringify(state, null, 2), "utf8");
}

/** Parses a raw Slack DM text into a question: null if it doesn't start with "?" after trimming. */
export function parseAskMessage(text: string): { question: string; mode: AskMode } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("?")) return null;
  const forcedDeep = trimmed.startsWith("??");
  const question = trimmed.slice(forcedDeep ? 2 : 1).trim();
  if (!question) return null;
  return { question, mode: forcedDeep ? "deep" : resolveAskMode("auto", question) };
}

/** Formats an ask envelope as a Slack reply: the answer, up to MAX_SOURCES sources, truncated to ~MAX_REPLY_CHARS. */
export function formatSlackReply(envelope: AskEnvelope): string {
  const lines = [envelope.answer];
  if (envelope.sources?.length) {
    lines.push("");
    lines.push("출처:");
    for (const s of envelope.sources.slice(0, MAX_SOURCES)) {
      lines.push(`  [${s.n}] ${s.title ? `${s.title} — ` : ""}${s.origin}`);
    }
  }
  const body = lines.join("\n");
  return body.length > MAX_REPLY_CHARS ? `${body.slice(0, MAX_REPLY_CHARS)}…` : body;
}

async function resolveSlackIdentity(slackUserId: string, dataDir: string): Promise<Identity | null> {
  const invites = await loadInvites(dataDir);
  const invite = invites.slice().reverse().find((i) => i.slack_user === slackUserId);
  if (!invite) return null;
  const users = await loadUsers(dataDir);
  const user = users.find((u) => u.name === invite.name && !u.revoked_at);
  if (!user) return null;
  return { name: user.name, role: user.role };
}

/** Polls Slack DMs for "?"-prefixed questions and answers them via the cosmos ask pipeline. */
export class SlackAskBridge {
  private timer: NodeJS.Timeout | null = null;
  private channelCache: { channels: SlackChannel[]; fetchedAt: number } | null = null;
  private botUserId: string | null = null;

  constructor(
    private readonly deps: SlackAskDeps,
    private readonly askDispatch: AskDispatch = defaultAskDispatch
  ) {}

  start(intervalS: number = DEFAULT_INTERVAL_S): void {
    this.timer = setInterval(() => {
      void this.poll();
    }, intervalS * 1000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Runs one poll cycle. Never throws — every failure is caught and logged so the process keeps running. */
  async poll(): Promise<void> {
    try {
      await this.pollUnsafe();
    } catch (err) {
      console.warn(`slack-ask 폴링 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private fetchImpl(): typeof fetch {
    return this.deps.fetchImpl ?? fetch;
  }

  private async listDmChannels(): Promise<SlackChannel[]> {
    const now = this.now();
    if (this.channelCache && now - this.channelCache.fetchedAt < CHANNEL_LIST_TTL_MS) {
      return this.channelCache.channels;
    }
    const res = await callSlack("conversations.list", { types: "im" }, this.deps.token, this.fetchImpl());
    const channels = Array.isArray(res["channels"]) ? (res["channels"] as SlackChannel[]) : [];
    this.channelCache = { channels, fetchedAt: now };
    return channels;
  }

  private async getBotUserId(): Promise<string | null> {
    if (this.botUserId) return this.botUserId;
    try {
      const res = await callSlack("auth.test", {}, this.deps.token, this.fetchImpl());
      this.botUserId = typeof res["user_id"] === "string" ? (res["user_id"] as string) : null;
    } catch (err) {
      console.warn(`slack-ask auth.test 실패: ${err instanceof Error ? err.message : String(err)}`);
      this.botUserId = null;
    }
    return this.botUserId;
  }

  private async pollUnsafe(): Promise<void> {
    const dataDir = this.deps.dataDir ?? defaultDataDir();
    const [channels, botUserId, state] = await Promise.all([this.listDmChannels(), this.getBotUserId(), loadState(dataDir)]);

    for (const channel of channels) {
      try {
        await this.pollChannel(channel, dataDir, botUserId, state);
      } catch (err) {
        console.warn(`slack-ask 채널(${channel.id}) 처리 실패: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private async pollChannel(channel: SlackChannel, dataDir: string, botUserId: string | null, state: SlackAskState): Promise<void> {
    const oldest = state[channel.id];
    const body: Record<string, unknown> = oldest ? { channel: channel.id, oldest } : { channel: channel.id, limit: 1 };
    const res = await callSlack("conversations.history", body, this.deps.token, this.fetchImpl());
    const messages = Array.isArray(res["messages"]) ? (res["messages"] as SlackMessage[]) : [];

    if (!oldest) {
      // First time seeing this channel: seed the watermark to the latest message instead of
      // answering pre-existing DM history, then wait for the next poll to pick up new messages.
      const latest = messages.reduce((max, m) => (m.ts > max ? m.ts : max), "0");
      state[channel.id] = latest;
      await saveState(dataDir, state);
      return;
    }

    const ordered = messages.slice().sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    for (const msg of ordered) {
      if (msg.ts <= oldest) continue;
      await this.handleMessage(channel, msg, dataDir, botUserId);
      state[channel.id] = msg.ts;
      await saveState(dataDir, state);
    }
  }

  private async handleMessage(channel: SlackChannel, msg: SlackMessage, dataDir: string, botUserId: string | null): Promise<void> {
    if (msg.bot_id || (botUserId && msg.user === botUserId)) return;
    if (!msg.text) return;
    const parsed = parseAskMessage(msg.text);
    if (!parsed) return;

    const slackUserId = channel.user ?? msg.user;
    const identity = slackUserId ? await resolveSlackIdentity(slackUserId, dataDir) : null;
    if (!identity) {
      await this.reply(channel.id, msg.ts, UNKNOWN_USER_REPLY);
      return;
    }

    const startedAt = this.now();
    try {
      const envelope = await this.askDispatch(parsed.question, parsed.mode, this.deps, identity);
      await this.reply(channel.id, msg.ts, formatSlackReply(envelope));
      this.logAsk(dataDir, { mode: parsed.mode, user: identity.name, ms: this.now() - startedAt, insufficient: envelope.insufficient, q: parsed.question });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.reply(channel.id, msg.ts, `질문 처리 중 오류가 발생했습니다: ${message}`);
      this.logAsk(dataDir, { mode: parsed.mode, user: identity.name, ms: this.now() - startedAt, insufficient: false, error: true, q: parsed.question });
    }
  }

  private async reply(channelId: string, threadTs: string, text: string): Promise<void> {
    await callSlack("chat.postMessage", { channel: channelId, thread_ts: threadTs, text }, this.deps.token, this.fetchImpl());
  }

  private logAsk(dataDir: string, info: { mode: AskMode; user: string; ms: number; insufficient: boolean; error?: true; q: string }): void {
    const secs = (info.ms / 1000).toFixed(1);
    console.log(`[ask] mode=${info.mode} user=${info.user} client=slack ${secs}s`);
    void appendAskLog(dataDir, { ts: new Date().toISOString(), client: "slack", ...info });
  }
}

/** Starts the Slack ask bridge. Caller is responsible for the SLACK_BOT_TOKEN / COSMOS_SLACK_ASK gate. */
export function startSlackAsk(core: CoreClient, llm: LlmClient): SlackAskBridge {
  const token = process.env.SLACK_BOT_TOKEN ?? "";
  const intervalS = Number(process.env.COSMOS_SLACK_ASK_INTERVAL_S) || DEFAULT_INTERVAL_S;
  const bridge = new SlackAskBridge({ core, llm, token });
  bridge.start(intervalS);
  return bridge;
}
