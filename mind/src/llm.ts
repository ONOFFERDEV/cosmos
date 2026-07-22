// LlmClient 추상화. CONTRACT.md M1 확장 절 지정대로 두 구현체를 둔다.
//  - claude-cli(기본): claude 실행파일을 직접 spawn. 프롬프트는 stdin으로 넣고 닫아 EOF 신호.
//  - api: ANTHROPIC_API_KEY가 있으면 Messages API 직접 호출.
// 선택은 env COSMOS_LLM (기본 claude-cli). 제약된 디코딩은 쓰지 않고, JSON 필드명·형식을
// 프롬프트에 직접 박아 넣은 뒤 completeJson()이 파싱 실패 시 1회 재시도한다.

import { spawn, spawnSync } from "node:child_process";
import { extractJson } from "./json-extract.js";

/** M3: 콜별로 모델을 고를 수 있다 — sonnet(기본, 클러스터 에이전트) | opus(플래너·종합). */
export type ModelAlias = "sonnet" | "opus";

export interface LlmClient {
  readonly model: string;
  complete(prompt: string, model?: ModelAlias): Promise<string>;
}

const CLAUDE_CLI_MODEL: ModelAlias = "sonnet";
/**
 * 모델별 기본 타임아웃(ms). claude CLI 헤드리스는 고정 오버헤드+생성으로
 * Sonnet 30~123s, Opus는 120s를 초과해 실측됨(CONTRACT.md LLM 타임아웃 규격).
 * sonnet은 3차 실측 개정으로 360s — deep 병렬 에이전트가 공유 레이트리밋 풀에서
 * 180s를 초과해 지연되는 사례가 확인됨.
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
 * claude CLI를 찾지 못했을 때 보여줄 한국어 에러 메시지.
 * 플랫폼별 탐색 명령(where.exe/which)을 메시지에 반영해 실제로 무엇이
 * 실패했는지 알 수 있게 한다.
 */
function claudeNotFoundMessage(platform: NodeJS.Platform): string {
  const probeCmd = platform === "win32" ? "where.exe claude" : "which claude";
  return `claude CLI 실행파일을 찾을 수 없습니다 (${probeCmd} 실패). PATH에 claude가 설치되어 있는지 확인하세요.`;
}

/** spawn의 "error" 이벤트가 실행파일 미발견(ENOENT)인지 판별한다. */
function isEnoentError(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT";
}

interface ExeProbeResult {
  status: number | null;
  stdout: string | null;
}
/** claude CLI 탐색 명령(where.exe/which)을 동기 실행하는 함수 타입 — 테스트에서 대역으로 주입한다. */
type ExeProbeFn = (command: string, args: string[]) => ExeProbeResult;

function defaultExeProbe(command: string, args: string[]): ExeProbeResult {
  return spawnSync(command, args, { encoding: "utf8" });
}

/**
 * claude CLI 실행파일 경로를 1회 해석해 캐시한다.
 *  - win32: where.exe로 해석하고 .cmd보다 .exe를 우선한다 (Windows에서
 *    shell:false + args 배열로 spawn하려면 실제 실행파일이 필요 — .cmd는
 *    셸 래퍼라 shell:false로는 직접 실행되지 않는다). where.exe가 실패하면
 *    즉시 에러를 던진다(캐시에도 실패를 기록해 재탐색하지 않는다).
 *  - 그 외(Linux/macOS): which로 해석을 시도한다. which 자체가 없거나
 *    실패해도(예: 최소 구성 컨테이너) 즉시 던지지 않고 "claude" 리터럴을
 *    반환해 spawn의 PATH 해석에 위임한다 — 정말 없으면 spawn 시점에
 *    ENOENT로 드러나고, ClaudeCliLlmClient.complete()가 이를 잡아 동일한
 *    한국어 에러로 변환한다.
 *
 * platform/probe 인자는 테스트에서 분기를 주입하기 위한 것으로, 실제
 * 호출부(complete())는 인자 없이 호출해 기본값(process.platform, 실제
 * spawnSync 기반 탐색)을 그대로 쓴다.
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

/** 테스트 전용: 모듈 레벨 캐시를 초기화한다. 프로덕션 코드에서는 사용하지 않는다. */
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
        // exePath가 "claude" 리터럴(비-win32에서 which 실패 후 PATH 해석에
        // 위임한 경우)일 때 실제로 못 찾으면 여기서 ENOENT로 드러난다.
        // 기존과 동일한 한국어 "찾을 수 없음" 에러로 변환해 던진다.
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
 * 모델별 LLM 호출 타임아웃(ms)을 결정한다.
 * env 오버라이드(COSMOS_LLM_TIMEOUT_SONNET_MS/COSMOS_LLM_TIMEOUT_OPUS_MS)가
 * 양의 숫자로 파싱되면 그 값을, 없거나 파싱에 실패하면 모델별 기본값을 반환한다
 * (CONTRACT.md LLM 타임아웃 규격 — claude-cli·api 두 백엔드 공통 적용).
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
 * LLM에 프롬프트를 보내고 응답에서 JSON을 추출한다.
 * 파싱 실패 시, 순수 JSON만 다시 요청하는 재시도 1회를 거친다 (CONTRACT.md: 실패 시 1회 재시도).
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
