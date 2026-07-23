// LlmClient abstraction. Two implementations per CONTRACT.md's M1 extension section.
//  - claude-cli (default): spawns the claude executable directly. The prompt goes in via
//    stdin, then stdin is closed to signal EOF.
//  - api: calls the Messages API directly when ANTHROPIC_API_KEY is set.
// Backend choice is env COSMOS_LLM (default claude-cli). We don't use constrained decoding —
// JSON field names/format are baked straight into the prompt, and completeJson() retries once
// on parse failure.

import { spawn, spawnSync } from "node:child_process";
import { extractJson } from "./json-extract.js";

/** M3: model can be chosen per call — sonnet (default, cluster agents) | opus (planner/synthesis). */
export type ModelAlias = "sonnet" | "opus";

export interface LlmClient {
  readonly model: string;
  complete(prompt: string, model?: ModelAlias): Promise<string>;
}

const CLAUDE_CLI_MODEL: ModelAlias = "sonnet";
/**
 * Default per-model timeout (ms). claude CLI headless runs measured at fixed overhead +
 * generation: Sonnet 30-123s, Opus over 120s (per CONTRACT.md's LLM timeout spec).
 * Sonnet was revised to 360s after a 3rd round of measurements — deep's parallel agents
 * were observed getting delayed past 180s in the shared rate-limit pool.
 */
const DEFAULT_TIMEOUT_MS: Record<ModelAlias, number> = {
  sonnet: 360_000,
  opus: 420_000,
};
const TIMEOUT_ENV_VAR: Record<ModelAlias, string> = {
  sonnet: "COSMOS_LLM_TIMEOUT_SONNET_MS",
  opus: "COSMOS_LLM_TIMEOUT_OPUS_MS",
};
const API_MODEL = "claude-sonnet-5";
const API_MODEL_MAP: Record<ModelAlias, string> = {
  sonnet: "claude-sonnet-5",
  opus: "claude-opus-4-8",
};
const API_MAX_TOKENS = 2000;
const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

let cachedClaudeExePath: string | null | undefined;

/**
 * Korean-language error message shown when the claude CLI can't be found.
 * Reflects the platform-specific probe command (where.exe/which) in the message
 * so it's clear what actually failed.
 */
function claudeNotFoundMessage(platform: NodeJS.Platform): string {
  const probeCmd = platform === "win32" ? "where.exe claude" : "which claude";
  return `claude CLI 실행파일을 찾을 수 없습니다 (${probeCmd} 실패). PATH에 claude가 설치되어 있는지 확인하세요.`;
}

/** Determines whether spawn's "error" event is an executable-not-found (ENOENT). */
function isEnoentError(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT";
}

interface ExeProbeResult {
  status: number | null;
  stdout: string | null;
}
/** Function type that synchronously runs the claude CLI probe command (where.exe/which) — tests inject a stand-in. */
type ExeProbeFn = (command: string, args: string[]) => ExeProbeResult;

function defaultExeProbe(command: string, args: string[]): ExeProbeResult {
  return spawnSync(command, args, { encoding: "utf8" });
}

/**
 * Resolves the claude CLI executable path once and caches it.
 *  - win32: resolves via where.exe, preferring .exe over .cmd (spawning with shell:false
 *    plus an args array needs an actual executable on Windows — .cmd is a shell wrapper
 *    that shell:false won't execute directly). If where.exe fails, throws immediately
 *    (the failure is cached too, so we don't re-probe).
 *  - everything else (Linux/macOS): tries to resolve via which. If which itself is
 *    missing or fails (e.g. a minimal container), it doesn't throw immediately — it
 *    returns the literal "claude" and defers to spawn's PATH resolution. If it's truly
 *    not there, that surfaces as ENOENT at spawn time, which ClaudeCliLlmClient.complete()
 *    catches and converts into the same Korean-language error.
 *
 * The platform/probe args exist so tests can inject a branch; the real call site
 * (complete()) calls this with no args, so it just uses the defaults (process.platform,
 * the real spawnSync-based probe).
 */
export function resolveClaudeExePath(
  platform: NodeJS.Platform = process.platform,
  probe: ExeProbeFn = defaultExeProbe
): string {
  if (cachedClaudeExePath !== undefined) {
    if (cachedClaudeExePath === null) {
      throw new Error(claudeNotFoundMessage(platform));
    }
    return cachedClaudeExePath;
  }

  if (platform === "win32") {
    const result = probe("where.exe", ["claude"]);
    const candidates = (result.stdout ?? "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    if (result.status !== 0 || candidates.length === 0) {
      cachedClaudeExePath = null;
      throw new Error(claudeNotFoundMessage(platform));
    }

    const exe = candidates.find((c) => c.toLowerCase().endsWith(".exe")) ?? candidates[0]!;
    cachedClaudeExePath = exe;
    return exe;
  }

  const result = probe("which", ["claude"]);
  const candidate = (result.stdout ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean);

  cachedClaudeExePath = result.status === 0 && candidate ? candidate : "claude";
  return cachedClaudeExePath;
}

/** Test-only: resets the module-level cache. Not used in production code. */
export function __resetClaudeExePathCacheForTest(): void {
  cachedClaudeExePath = undefined;
}

export class ClaudeCliLlmClient implements LlmClient {
  readonly model = CLAUDE_CLI_MODEL;

  async complete(prompt: string, model: ModelAlias = CLAUDE_CLI_MODEL): Promise<string> {
    const exePath = resolveClaudeExePath();
    const timeoutMs = resolveTimeoutMs(model);
    return new Promise<string>((resolve, reject) => {
      const child = spawn(exePath, ["-p", "--model", model, "--output-format", "text"], {
        shell: false,
      });

      let stdout = "";
      let stderr = "";
      let settled = false;

      const timer = setTimeout(() => {
        settled = true;
        child.kill();
        reject(new Error(`claude CLI 호출(model: ${model})이 ${timeoutMs}ms 내에 끝나지 않아 중단했습니다.`));
      }, timeoutMs);

      child.stdout.on("data", (d: Buffer) => {
        stdout += d.toString("utf8");
      });
      child.stderr.on("data", (d: Buffer) => {
        stderr += d.toString("utf8");
      });
      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // If exePath is the literal "claude" (which failed on non-win32, deferring to
        // PATH resolution) and it's truly not found, that surfaces here as ENOENT.
        // Convert it into the same Korean-language "not found" error as before.
        reject(isEnoentError(err) ? new Error(claudeNotFoundMessage(process.platform)) : err);
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`claude CLI가 코드 ${code}로 종료됨: ${stderr.trim() || "(stderr 없음)"}`));
          return;
        }
        resolve(stdout);
      });

      child.stdin.write(prompt, "utf8");
      child.stdin.end();
    });
  }
}

export class ApiLlmClient implements LlmClient {
  readonly model = API_MODEL;

  constructor(private readonly apiKey: string) {}

  async complete(prompt: string, model: ModelAlias = "sonnet"): Promise<string> {
    const timeoutMs = resolveTimeoutMs(model);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": API_VERSION,
        },
        body: JSON.stringify({
          model: API_MODEL_MAP[model],
          max_tokens: API_MAX_TOKENS,
          messages: [{ role: "user", content: prompt }],
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Claude API 호출 실패 (status ${res.status}): ${body}`);
      }
      const data = (await res.json()) as { content?: { type: string; text?: string }[] };
      const text = data.content?.find((b) => b.type === "text")?.text;
      if (!text) {
        throw new Error("Claude API 응답에 텍스트 블록이 없습니다.");
      }
      return text;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`Claude API 호출(model: ${model})이 ${timeoutMs}ms 내에 끝나지 않아 중단했습니다.`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Determines the per-model LLM call timeout (ms).
 * If the env override (COSMOS_LLM_TIMEOUT_SONNET_MS/COSMOS_LLM_TIMEOUT_OPUS_MS) parses
 * as a positive number, returns that value; otherwise returns the model's default
 * (per CONTRACT.md's LLM timeout spec — applies to both the claude-cli and api backends).
 */
export function resolveTimeoutMs(model: ModelAlias): number {
  const raw = process.env[TIMEOUT_ENV_VAR[model]];
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_TIMEOUT_MS[model];
}

export function resolveLlmClient(): LlmClient {
  const backend = process.env["COSMOS_LLM"] ?? "claude-cli";
  if (backend === "api") {
    const apiKey = process.env["ANTHROPIC_API_KEY"];
    if (!apiKey) {
      throw new Error("COSMOS_LLM=api로 지정했지만 ANTHROPIC_API_KEY 환경변수가 없습니다.");
    }
    return new ApiLlmClient(apiKey);
  }
  if (backend !== "claude-cli") {
    throw new Error(`알 수 없는 COSMOS_LLM 값: ${backend} (claude-cli 또는 api만 지원)`);
  }
  return new ClaudeCliLlmClient();
}

/**
 * Sends a prompt to the LLM and extracts JSON from the response.
 * On parse failure, retries once by asking for pure JSON only (CONTRACT.md: retry once on failure).
 */
export async function completeJson<T>(llm: LlmClient, prompt: string, model?: ModelAlias): Promise<T> {
  const first = await llm.complete(prompt, model);
  try {
    return extractJson(first) as T;
  } catch {
    const retryPrompt = `${prompt}\n\n(주의: 이전 응답이 올바른 JSON이 아니었습니다. 설명이나 마크다운 없이 순수 JSON 객체만 출력하세요.)`;
    const second = await llm.complete(retryPrompt, model);
    return extractJson(second) as T;
  }
}
