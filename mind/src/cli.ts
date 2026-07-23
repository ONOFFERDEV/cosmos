// mind CLI entry point.
// Usage: node dist/cli.js bootstrap | ask "question" [--deep] | serve [--port 8800]
//        | collect | inbox|approve|reject(deprecated — unified into branch review) | scan | ingest <path|URL> [--type manual]
//        | lifecycle run [--dry-run]|status | universe | digest [--all]
//        | user add <name> [--role member|admin]|list|revoke <name>
//        | invite <name> <slack-member-id> [--role member|admin]

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CosmosCoreClient, type CoreClient, type SourceType } from "./core-client.js";
import { resolveLlmClient } from "./llm.js";
import { runAsk } from "./ask.js";
import { runDeepAsk } from "./deep.js";
import { runBootstrap } from "./bootstrap.js";
import { createMindServer, DEFAULT_MIND_PORT } from "./server.js";
import { loadConfig } from "./config.js";
import { runCollect, migrateLegacyInbox, stripHtmlTags, decodeXmlEntities } from "./collect.js";
import { scanOnce, startWatcherLoop } from "./watcher.js";
import { runLifecycle, lifecycleStatus } from "./lifecycle.js";
import { buildUniverse } from "./universe.js";
import { generateDigests } from "./digest.js";
import { startCronJobs } from "./cron.js";
import { addUser, listUsers, revokeUser, type Role } from "./users.js";
import { sendInvite, checkInvites } from "./invite.js";

const INBOX_MIGRATED_MESSAGE = "브랜치 검토로 일원화되었습니다 — 웹 검토 화면 또는 /branches 사용";

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;

  const core = new CosmosCoreClient();
  const llm = resolveLlmClient();

  switch (command) {
    case "bootstrap": {
      // M9: --owner <name> bootstraps (and labels) the personal scope; --force regenerates only that scope.
      const force = rest.includes("--force");
      const ownerIdx = rest.indexOf("--owner");
      const owner = ownerIdx !== -1 ? rest[ownerIdx + 1] : undefined;
      await runBootstrap({ core, llm }, { ...(force ? { force } : {}), ...(owner ? { owner } : {}) });
      return;
    }
    case "ask": {
      const deepIdx = rest.indexOf("--deep");
      const isDeep = deepIdx !== -1;
      const questionArgs = isDeep ? [...rest.slice(0, deepIdx), ...rest.slice(deepIdx + 1)] : rest;
      const question = questionArgs.join(" ").trim();
      if (!question) {
        throw new Error('사용법: node dist/cli.js ask "질문" [--deep]');
      }
      const envelope = isDeep
        ? await runDeepAsk(question, { core, llm })
        : await runAsk(question, { core, llm });
      console.log(JSON.stringify(envelope, null, 2));
      return;
    }
    case "serve": {
      const port = parsePort(rest) ?? DEFAULT_MIND_PORT;
      const server = createMindServer({ core, llm });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, () => {
          console.log(`cosmos-mind 서버가 http://127.0.0.1:${port} 에서 대기 중입니다.`);
          resolve();
        });
      });
      try {
        const config = await loadConfig();
        if (await anyDirExists(config.watcher.dirs)) {
          startWatcherLoop(config.watcher, { core });
          console.log(`워처 시작: ${config.watcher.dirs.length}개 디렉토리, ${config.watcher.interval_secs}초 간격.`);
        } else {
          console.log("워처 비활성: 대상 디렉터리 없음");
        }
        startCronJobs(config, core, llm);
      } catch (err) {
        console.warn(`워처 시작 실패(설정 로드 오류로 계속 진행): ${(err as Error).message}`);
      }
      if (process.env.SLACK_BOT_TOKEN) {
        setInterval(() => {
          void checkInvites();
        }, 60_000).unref();
        console.log("초대 봇 활성");
      }
      try {
        await migrateLegacyInbox({ core });
      } catch (err) {
        console.warn(`레거시 인박스 이전 실패(서버는 계속 실행됩니다): ${(err as Error).message}`);
      }
      return;
    }
    case "collect": {
      const summary = await runCollect({ core });
      console.log(JSON.stringify(summary, null, 2));
      return;
    }
    case "inbox":
    case "approve":
    case "reject": {
      console.log(INBOX_MIGRATED_MESSAGE);
      return;
    }
    case "user": {
      const sub = rest[0];
      if (sub === "add") {
        const name = rest[1];
        if (!name) {
          throw new Error("사용법: node dist/cli.js user add <이름> [--role member|admin]");
        }
        const roleIdx = rest.indexOf("--role");
        const role = (roleIdx !== -1 && rest[roleIdx + 1] ? rest[roleIdx + 1] : "member") as Role;
        if (role !== "admin" && role !== "member") {
          throw new Error("--role은 member 또는 admin이어야 합니다.");
        }
        const token = await addUser(name, role);
        console.log(`사용자 추가됨: ${name} (${role})`);
        console.log(`토큰(다시 표시되지 않습니다): ${token}`);
        return;
      }
      if (sub === "list") {
        const users = await listUsers();
        console.log(JSON.stringify(users, null, 2));
        return;
      }
      if (sub === "revoke") {
        const name = rest[1];
        if (!name) {
          throw new Error("사용법: node dist/cli.js user revoke <이름>");
        }
        const ok = await revokeUser(name);
        console.log(ok ? `사용자 폐기됨: ${name}` : `사용자를 찾을 수 없습니다: ${name}`);
        return;
      }
      throw new Error("사용법: node dist/cli.js user add <이름> [--role member|admin]|list|revoke <이름>");
    }
    case "invite": {
      const name = rest[0];
      const slackUserId = rest[1];
      if (!name || !slackUserId) {
        throw new Error("사용법: node dist/cli.js invite <이름> <슬랙멤버ID> [--role member|admin]");
      }
      const roleIdx = rest.indexOf("--role");
      const role = (roleIdx !== -1 && rest[roleIdx + 1] ? rest[roleIdx + 1] : "member") as Role;
      if (role !== "admin" && role !== "member") {
        throw new Error("--role은 member 또는 admin이어야 합니다.");
      }
      const result = await sendInvite(name, slackUserId, role);
      if (result.delivered) {
        console.log(`DM 발송됨: ${name} (슬랙 ${slackUserId})`);
      } else {
        console.log("슬랙 DM 발송 실패 — 아래 토큰을 직접 전달하세요.");
        console.log(`토큰(다시 표시되지 않습니다): ${result.token}`);
      }
      return;
    }
    case "scan": {
      const config = await loadConfig();
      const summary = await scanOnce(config.watcher, { core });
      console.log(JSON.stringify(summary, null, 2));
      return;
    }
    case "ingest": {
      const src = rest.find((a) => !a.startsWith("--"));
      if (!src) {
        throw new Error('사용법: node dist/cli.js ingest <경로|URL> [--type manual]');
      }
      const typeIdx = rest.indexOf("--type");
      const sourceType = (typeIdx !== -1 && rest[typeIdx + 1] ? rest[typeIdx + 1] : "manual") as SourceType;
      await runManualIngest(src, sourceType, core);
      return;
    }
    case "lifecycle": {
      const sub = rest[0];
      const config = await loadConfig();
      if (sub === "status") {
        await lifecycleStatus({ core, config: config.lifecycle });
        return;
      }
      if (sub === "run") {
        const dryRun = rest.includes("--dry-run");
        await runLifecycle({ core, llm, config: config.lifecycle }, { dryRun });
        return;
      }
      throw new Error('사용법: node dist/cli.js lifecycle run [--dry-run]|status');
    }
    case "universe": {
      const payload = await buildUniverse({ core });
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    case "digest": {
      const all = rest.includes("--all");
      const result = await generateDigests({ core, llm }, { all });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    default:
      throw new Error(
        `알 수 없는 명령: ${command ?? "(없음)"}\n` +
          `사용법: node dist/cli.js bootstrap|ask "질문" [--deep]|serve [--port 8800]|collect|inbox|approve|reject(폐기)|scan|ingest <경로|URL> [--type manual]|lifecycle run [--dry-run]|status|universe|digest [--all]|user add <이름> [--role member|admin]|list|revoke <이름>|invite <이름> <슬랙멤버ID> [--role member|admin]`
      );
  }
}

async function runManualIngest(src: string, sourceType: SourceType, core: CoreClient): Promise<void> {
  let text: string;
  let title: string | undefined;
  const isUrl = /^https?:\/\//i.test(src);
  if (isUrl) {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`URL 가져오기 실패: HTTP ${res.status}`);
    const html = await res.text();
    text = stripHtmlTags(html);
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    title = titleMatch ? decodeXmlEntities(titleMatch[1]).trim() : undefined;
  } else {
    const ext = path.extname(src).toLowerCase();
    if (ext !== ".md" && ext !== ".txt") {
      throw new Error(`지원하지 않는 파일 형식: ${ext} (.md 또는 .txt만 가능)`);
    }
    text = await readFile(src, "utf8");
    title = path.basename(src, ext);
  }
  const response = await core.ingest({
    docs: [{ origin: src, source_type: sourceType, ...(title ? { title } : {}), text }],
  });
  console.log(JSON.stringify(response, null, 2));
}

function parsePort(args: string[]): number | null {
  const idx = args.indexOf("--port");
  if (idx === -1 || idx + 1 >= args.length) {
    return null;
  }
  const value = Number(args[idx + 1]);
  return Number.isInteger(value) && value > 0 ? value : null;
}

// True if at least one of dirs actually exists on disk. Used at serve startup to
// decide whether to auto-skip the watcher (if none of the target directories exist, the watcher never starts at all).
export async function anyDirExists(dirs: string[]): Promise<boolean> {
  const results = await Promise.all(
    dirs.map((d) =>
      stat(d)
        .then(() => true)
        .catch(() => false)
    )
  );
  return results.some(Boolean);
}

// Only drive main() when import.meta.url === this file's actual execution path.
// Prevents CLI dispatch (main) from also running when something like cli.test.ts
// only imports anyDirExists, which would pollute process.exitCode with an unknown command.
const isMainModule = process.argv[1] ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) : false;
if (isMainModule) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
