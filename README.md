# Research Tree

Agent-driven research tool. The root question decomposes into a tree of sub-questions, each branch runs parallel web search + synthesis, findings roll up while preserving disagreement between sources (instead of blending into mush).

Structured contradiction detection emits a typed `Contradiction[]` array on every internal rollup, surfaced in the UI as a `⚠ N contradictions` badge with branch attribution.

See `.context/attachments/pasted_text_2026-05-07_00-51-13.txt` for the full design doc.

## Setup

```bash
cp .env.local.example .env.local
# fill in ANTHROPIC_API_KEY and TAVILY_API_KEY
pnpm install
```

## Run

Dev server (frontend, agent endpoints):

```bash
pnpm dev
# http://localhost:3000
```

CLI test of the agent pipeline (search → plan → search children → rollup with contradictions):

```bash
pnpm test-agents
```

## Architecture

- `app/api/agents/*` — three stateless agent endpoints (search, plan, rollup). Each is a single LLM/Tavily call with no memory between calls.
- `app/` — frontend canvas (Phase 4+, not yet built).
- `lib/types.ts` — shared types (`ResearchNode`, `Contradiction`, request/response shapes).
- `lib/prompts.ts` — system prompts + tool schemas for the three agents.
- `lib/anthropic.ts` — Anthropic SDK wrapper with tool use and prompt caching.
- `lib/tavily.ts` — Tavily search client.
- `lib/retry.ts` — exponential backoff retry helper (1s/2s/4s on 5xx, 429, network errors).
- `scripts/test-agents.ts` — CLI driver that exercises the pipeline end-to-end.

Tree state lives in the client; server endpoints are thin proxies. No SSE, no sessions, no JSON snapshots.

## Models

All three agents use `claude-haiku-4-5-20251001` (fast, cheap, structured output via tool use).

System prompts are cached via `cache_control: { type: 'ephemeral' }` to amortize cost across the ~30 calls per research session.
