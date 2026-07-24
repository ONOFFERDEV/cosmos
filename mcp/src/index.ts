#!/usr/bin/env node
// Cosmos M5 — mind HTTP API를 감싸는 MCP stdio 브리지.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  MindClient,
  MindApiError,
  DEFAULT_MIND_BASE_URL,
  type AskResponse,
  type SearchResponse,
  type HealthResponse,
  type UniverseResponse,
  type BranchSummary,
} from "./mind-client.js";

const baseUrl = process.env.COSMOS_MIND_URL || DEFAULT_MIND_BASE_URL;
const token = process.env.COSMOS_TOKEN || undefined;
const mind = new MindClient(baseUrl, token);

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function errorResult(err: unknown): ToolResult {
  const message = err instanceof MindApiError ? err.message : err instanceof Error ? `내부 오류: ${err.message}` : `알 수 없는 오류: ${String(err)}`;
  return { content: [{ type: "text", text: message }], isError: true };
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

function formatAsk(res: AskResponse, question: string, mode: string): string {
  const lines: string[] = [];
  lines.push(`질문: ${question} (모드: ${mode})`);
  if (res.insufficient) {
    lines.push("⚠️ 근거 자료가 부족하다고 판단했습니다. 아래는 참고용 답변입니다.");
  }
  lines.push("");
  lines.push(res.answer ?? "(답변 없음)");

  if (res.sources?.length) {
    lines.push("");
    lines.push("출처:");
    for (const s of res.sources) {
      lines.push(`  [${s.n}] ${s.title ? `${s.title} — ` : ""}${s.origin}`);
    }
  }

  if (res.trace?.length) {
    lines.push("");
    lines.push("경유/건너뜀 궤적:");
    for (const t of res.trace) {
      lines.push(`  - ${t.cluster}: ${t.action} (${t.why})`);
    }
  }

  if (res.cost) {
    lines.push("");
    lines.push(`비용: LLM 호출 ${res.cost.llm_calls}회, ${res.cost.secs.toFixed(1)}초`);
  }

  return lines.join("\n");
}

function formatSearch(res: SearchResponse, query: string): string {
  const results = Array.isArray(res?.results) ? res.results : [];
  if (results.length === 0) {
    return `"${query}" 검색 결과가 없습니다.`;
  }
  const lines = [`"${query}" 검색 결과 (상위 ${results.length}건):`, ""];
  results.forEach((r, i) => {
    const title = r.title ? `${r.title} — ` : "";
    const origin = r.origin ?? r.doc_id ?? "(출처 미상)";
    const score = typeof r.score === "number" ? ` (score ${r.score.toFixed(3)})` : "";
    const preview = (r.text ?? "").slice(0, 300).replace(/\s+/g, " ").trim();
    lines.push(`${i + 1}. ${title}${origin}${score}`);
    if (preview) lines.push(`   ${preview}${(r.text?.length ?? 0) > 300 ? "…" : ""}`);
  });
  return lines.join("\n");
}

function formatHealth(res: HealthResponse): string {
  const lines = [`상태: ${res.status}`];
  if (res.core) {
    lines.push(`문서 ${res.core.docs ?? "?"}개, 청크 ${res.core.chunks ?? "?"}개, 클러스터 ${res.core.clusters ?? "?"}개`);
  }
  return lines.join("\n");
}

function formatUniverse(res: UniverseResponse): string {
  const clusters = Array.isArray(res?.clusters) ? res.clusters : [];
  if (clusters.length === 0) return "클러스터가 없습니다.";
  const lines = [`클러스터 ${clusters.length}개:`];
  for (const c of clusters) {
    lines.push(`  - ${c.name} (${c.slug}): 문서 ${c.n_docs}개`);
  }
  return lines.join("\n");
}

function formatBranches(branches: BranchSummary[]): string {
  if (!branches?.length) return "브랜치가 없습니다.";
  const lines = [`브랜치 ${branches.length}개:`];
  for (const b of branches) {
    const creator = b.created_by ? ` by ${b.created_by}` : "";
    const merged = b.merged_at ? `, 병합 ${b.merged_at}` : "";
    lines.push(`  - [${b.id}] ${b.name} (${b.status})${creator} — 생성 ${b.created_at}${merged}`);
  }
  return lines.join("\n");
}

const server = new McpServer({
  name: "cosmos-mcp",
  version: "0.1.0",
});

server.registerTool(
  "cosmos_ask",
  {
    title: "Cosmos 질의응답",
    description:
      "Cosmos 지식 코스모스에 질문한다. fast 모드는 약 1분, deep 모드는 여러 클러스터를 순회하며 수 분(최대 20분)까지 걸릴 수 있다. " +
      "답변과 함께 출처 목록, 경유/건너뜀 궤적을 반환한다.",
    inputSchema: {
      question: z.string().min(1).describe("질문 내용"),
      mode: z.enum(["fast", "deep"]).optional().describe("fast(기본, ~1분) 또는 deep(수 분 소요, 심층 순회)"),
    },
  },
  async ({ question, mode }) => {
    try {
      const res = await mind.ask({ question, mode });
      return ok(formatAsk(res, question, mode ?? "fast"));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cosmos_search",
  {
    title: "Cosmos 청크 검색",
    description: "Cosmos 지식 코스모스에서 질의어와 관련된 상위 청크를 미리보기로 검색한다.",
    inputSchema: {
      query: z.string().min(1).describe("검색 질의어"),
      k: z.number().int().positive().optional().describe("반환할 결과 개수 (기본값은 서버 설정을 따름)"),
    },
  },
  async ({ query, k }) => {
    try {
      const res = await mind.search(query, k);
      return ok(formatSearch(res, query));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cosmos_ingest",
  {
    title: "Cosmos 문서 편입",
    description:
      "텍스트 또는 URL을 manual 문서로 Cosmos 지식 코스모스에 편입한다. url을 지정하면 해당 페이지를 가져와 HTML 태그를 제거한 뒤 편입한다. " +
      "text와 url 중 하나는 반드시 지정해야 한다.",
    inputSchema: {
      text: z.string().optional().describe("편입할 원문 텍스트 (url 대신 직접 텍스트를 줄 때)"),
      url: z.string().url().optional().describe("편입할 웹 페이지 URL (지정 시 fetch 후 태그 스트립)"),
      title: z.string().optional().describe("문서 제목 (생략 가능)"),
    },
  },
  async ({ text, url, title }) => {
    try {
      let finalText = text;
      let origin = url ?? "manual";

      if (url) {
        let res: Response;
        try {
          res = await fetch(url);
        } catch (err) {
          return errorResult(new MindApiError(`URL을 가져오지 못했습니다 (${url}): ${err instanceof Error ? err.message : String(err)}`));
        }
        if (!res.ok) {
          return errorResult(new MindApiError(`URL 응답 오류 (${url}): status ${res.status}`));
        }
        const html = await res.text();
        finalText = stripHtml(html);
      }

      if (!finalText || !finalText.trim()) {
        return errorResult(new MindApiError("text 또는 url 중 하나를 지정해야 하며, 편입할 내용이 비어 있지 않아야 합니다."));
      }

      const result = await mind.ingest([
        {
          origin,
          source_type: "manual",
          title,
          text: finalText,
        },
      ]);

      const count = Array.isArray(result?.ingested) ? result.ingested.length : 0;
      return ok(`편입 완료: ${count}건 처리됨.\n원본: ${origin}${title ? ` (${title})` : ""}`);
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cosmos_branches",
  {
    title: "Cosmos 브랜치 목록",
    description: "지식 브랜치(격리된 변경 집합) 목록을 조회한다. status로 open/merged/discarded 필터링 가능.",
    inputSchema: {
      status: z.enum(["open", "merged", "discarded"]).optional().describe("상태 필터 (생략 시 전체 브랜치)"),
    },
  },
  async ({ status }) => {
    try {
      const branches = await mind.branches(status);
      return ok(formatBranches(branches));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cosmos_status",
  {
    title: "Cosmos 상태 요약",
    description: "mind/core 헬스체크와 클러스터 요약을 함께 보여준다.",
    inputSchema: {},
  },
  async () => {
    try {
      const [health, universe] = await Promise.all([mind.health(), mind.universe()]);
      return ok(`${formatHealth(health)}\n\n${formatUniverse(universe)}`);
    } catch (err) {
      return errorResult(err);
    }
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(`cosmos-mcp 서버 시작 실패: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
