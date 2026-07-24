// cosmos-mind(HTTP, 기본 :8800) API 클라이언트.
// ask deep 모드는 최대 1200초까지 걸릴 수 있어 undici(fetch)의 기본 헤더 타임아웃(약 300초) 함정을
// 피하려고 node:http/node:https를 직접 사용한다 (오케스트레이터 지시사항).

import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

export const DEFAULT_MIND_BASE_URL = "http://localhost:8800";

export type AskMode = "fast" | "deep";

export interface AskRequest {
  question: string;
  mode?: AskMode;
}

export interface AskSource {
  n: number;
  origin: string;
  title?: string;
}

export interface AskTraceStep {
  cluster: string;
  action: string;
  why: string;
}

export interface AskCost {
  llm_calls: number;
  secs: number;
}

export interface AskResponse {
  answer: string;
  sentences: string[];
  sources: AskSource[];
  trace: AskTraceStep[];
  insufficient: boolean;
  cost: AskCost;
}

export interface HealthResponse {
  status: string;
  core: {
    docs: number;
    chunks: number;
    clusters: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface UniverseCluster {
  slug: string;
  name: string;
  n_docs: number;
  [key: string]: unknown;
}

export interface UniverseResponse {
  clusters: UniverseCluster[];
  [key: string]: unknown;
}

// M8 branch (isolated change set) summary — mirrors mind's core-client.ts BranchSummary.
export interface BranchSummary {
  id: string;
  name: string;
  status: "open" | "merged" | "discarded";
  created_by?: string;
  created_at: string;
  merged_at?: string;
}

export interface IngestDoc {
  origin: string;
  source_type: "manual";
  title?: string;
  text: string;
}

export interface IngestResponse {
  ingested: unknown[];
  [key: string]: unknown;
}

/** core /search와 동일한 계약을 mind가 프록시한다고 가정한 응답 형태. */
export interface SearchResult {
  chunk_id?: string;
  doc_id?: string;
  origin?: string;
  title?: string;
  text?: string;
  score?: number;
  [key: string]: unknown;
}

export interface SearchResponse {
  results: SearchResult[];
  [key: string]: unknown;
}

export class MindApiError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "MindApiError";
  }
}

const FAST_TIMEOUT_MS = 300_000;
const DEEP_TIMEOUT_MS = 1_200_000;
const DEFAULT_TIMEOUT_MS = 30_000;

export class MindClient {
  constructor(
    private readonly baseUrl: string = DEFAULT_MIND_BASE_URL,
    private readonly token?: string,
  ) {}

  async ask(req: AskRequest): Promise<AskResponse> {
    const timeoutMs = req.mode === "deep" ? DEEP_TIMEOUT_MS : FAST_TIMEOUT_MS;
    return this.request<AskResponse>("POST", "/ask", req, timeoutMs);
  }

  async search(query: string, k?: number): Promise<SearchResponse> {
    return this.request<SearchResponse>("POST", "/search", { query, k }, DEFAULT_TIMEOUT_MS);
  }

  async health(): Promise<HealthResponse> {
    return this.request<HealthResponse>("GET", "/health", undefined, 15_000);
  }

  async universe(): Promise<UniverseResponse> {
    return this.request<UniverseResponse>("GET", "/universe", undefined, DEFAULT_TIMEOUT_MS);
  }

  async branches(status?: string): Promise<BranchSummary[]> {
    const query = status ? `?status=${encodeURIComponent(status)}` : "";
    return this.request<BranchSummary[]>("GET", `/branches${query}`, undefined, DEFAULT_TIMEOUT_MS);
  }

  async ingest(docs: IngestDoc[]): Promise<IngestResponse> {
    return this.request<IngestResponse>("POST", "/ingest", { docs }, 120_000);
  }

  private request<T>(method: string, path: string, body: unknown, timeoutMs: number): Promise<T> {
    return new Promise((resolve, reject) => {
      let url: URL;
      try {
        url = new URL(path, this.baseUrl);
      } catch (err) {
        reject(new MindApiError(`COSMOS_MIND_URL이 올바르지 않습니다: "${this.baseUrl}"`, err));
        return;
      }

      const transport = url.protocol === "https:" ? https : http;
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const headers: Record<string, string> = { "X-Cosmos-Client": "mcp" };
      if (payload !== undefined) {
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = Buffer.byteLength(payload).toString();
      }
      if (this.token) {
        headers["Authorization"] = `Bearer ${this.token}`;
      }

      let timedOut = false;
      const req = transport.request(
        {
          method,
          hostname: url.hostname,
          port: url.port || (url.protocol === "https:" ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          headers,
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            const status = res.statusCode ?? 0;
            if (status < 200 || status >= 300) {
              reject(new MindApiError(`mind ${path} 요청 실패 (status ${status}): ${text.slice(0, 500)}`));
              return;
            }
            if (!text) {
              resolve(undefined as T);
              return;
            }
            try {
              resolve(JSON.parse(text) as T);
            } catch (err) {
              reject(new MindApiError(`mind ${path} 응답을 JSON으로 파싱하지 못했습니다`, err));
            }
          });
        },
      );

      req.on("timeout", () => {
        timedOut = true;
        req.destroy();
      });

      req.on("error", (err: NodeJS.ErrnoException) => {
        if (timedOut) {
          reject(new MindApiError(`mind ${path} 요청이 ${Math.round(timeoutMs / 1000)}초 안에 응답하지 않았습니다 (타임아웃)`));
          return;
        }
        if (["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "EHOSTUNREACH"].includes(err.code ?? "")) {
          reject(new MindApiError(`COSMOS_MIND_URL(${this.baseUrl}) 접속 실패: ${err.message}`, err));
          return;
        }
        reject(new MindApiError(`mind ${path} 요청 중 오류: ${err.message}`, err));
      });

      if (payload !== undefined) {
        req.write(payload);
      }
      req.end();
    });
  }
}
