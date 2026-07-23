# Cosmos — a living knowledge cosmos

*[한국어](README.ko.md)*

A **self-hosted knowledge system** where your team's knowledge lives in clusters (topic-level ontologies), and every question is answered by consulting the relevant clusters (skipping the rest) — assembled into an answer with **sources + a consultation trace**.

- **Shared/personal separation** — team knowledge and each member's personal knowledge are isolated (zero exposure to anonymous users or other members); personal knowledge is promoted to shared via knowledge PRs
- **Personal knowledge = your own GitHub repo** — push .md files and the server pulls them (nothing installed on your PC); an AI-executable setup runbook is included
- **Knowledge PRs** — external collections (arXiv/RSS) are quarantined in branches → admin review, cherry-pick merge, lossless journal rollback
- **Relation graph** — `[[wikilinks]]` and frontmatter in your documents become a deterministic relation graph (no LLM extraction), used for search expansion and 3D relation lines
- **3D cosmos view** + a chat with live progress (fast/deep/global modes) + an MCP bridge
- Stack: `core/` (Rust — indexing, hybrid search, clusters, journal) + `mind/` (TypeScript — LLM pipeline, auth, collectors, web) — LLM via the Anthropic API

## License

**MIT** — free for anyone, individual or company, to use, modify, redistribute, and commercialize. Full text: `LICENSE.md`

## Getting started

- **Install for a new org/individual**: `docs/SETUP.md` (one Docker host, ~10 minutes)
- **Team member guide**: `docs/TEAM-KNOWLEDGE.md` · **Spec of record**: the "현재 계약 스냅샷" (current contract snapshot) section at the top of `contract/CONTRACT.md` + `contract/openapi.yaml`
- **Design rationale**: `docs/PLAN.md` · **AI agent guide**: `CLAUDE.md`

Note: product UI and the design documents are currently written in Korean; the codebase comments are in English.

## Local development

```bash
cd core && cargo test                      # Rust engine (ignored tests need a model cache: -- --ignored)
cd mind && npm test                        # full TypeScript suite
node mind/dist/cli.js serve --port 8807    # local server → http://localhost:8807/?fixture=1 (3D view with sample data)
```
