# Chain of Thought

Agent-driven research tool. The root question becomes a tree of sub-questions, with each branch running parallel web search and synthesis. Findings roll up into structured `Claim` objects with branch attribution. Contradictions are claims whose `opposing` source list is non-empty, surfaced in the UI alongside their supporting branches.

## Running locally

### 1. Prerequisites

- Node 20 or newer (tested on 24).
- pnpm 9 or newer. Install with `npm install -g pnpm` if you don't have it.
- An Anthropic API key. Sign up at https://console.anthropic.com and create a key at https://console.anthropic.com/settings/keys. Set a low spending limit on your account before sharing the demo URL.
- A Tavily API key. Sign up at https://tavily.com and grab a key from the dashboard. The free tier gives 1000 queries per month, plenty for development.
- A password value for the login gate (any string you'll remember).

### 2. Clone and install

```bash
git clone https://github.com/cfiorini74/chain-of-thought.git
cd chain-of-thought
pnpm install
```

### 3. Configure environment variables

```bash
cp .env.local.example .env.local
```

Edit `.env.local`:

```
ANTHROPIC_API_KEY=sk-ant-...     # from console.anthropic.com
TAVILY_API_KEY=tvly-...          # from tavily.com
DEMO_PASSWORD=pick-anything      # what users type at the login form
AUTH_SECRET=...                  # generate with: openssl rand -base64 32
```

The `AUTH_SECRET` signs the session cookie. Anything 32+ bytes of randomness works. Don't commit `.env.local`.

### 4. Start the dev server

```bash
pnpm dev
```

Open http://localhost:3000. The first request triggers Next.js compilation, so expect a 1 to 3 second delay on the initial load.

### 5. Use the app

1. Enter `DEMO_PASSWORD` at the login screen.
2. Type a question on the landing page (for example, "Is MSFT a good investment right now?") and click Research. The root node builds: search, synthesize, extract claims. Expect 5 to 10 seconds.
3. Click any node to open the side panel. You'll see Findings (the synthesized prose), Claims (structured facts with supporting and opposing citations), and Sources (raw search results with quotes).
4. Click Expand on a node to spawn child sub-questions. On the first expand of a leaf, the planner suggests a list of sub-questions; you can edit any of them or add your own. On re-expand (a node that already has children), the form starts blank so additions stay custom.
5. Click Summarize on the root (or any internal node) to fold children's claims into the parent. Only stale branches re-roll; clean branches are skipped.
6. The X on any claim row excludes that claim from upward rollups. Click Summarize again to apply.
7. Click Delete to drop a subtree. The parent is marked stale so the next Summarize cleans up the orphaned origins.

### Common issues

- **"Failed to fetch" on login**: `AUTH_SECRET` is empty or missing in `.env.local`. The login route requires a real secret.
- **All nodes turn red with "401"**: session cookie expired (12-hour lifetime) or the server restarted with a new `AUTH_SECRET`. Log out and back in.
- **All nodes turn red with "529" or "overloaded"**: Anthropic is throttling you. The built-in retry should recover. If it persists, wait a minute or check your account status.
- **Port 3000 already in use**: kill the other process or run with `PORT=3001 pnpm dev`.

## Tests

```bash
pnpm test-orchestrator   # fast; mock agents, no network
pnpm test-agents         # slow; hits Anthropic and Tavily for real
```

`test-orchestrator` is the one to run during development. It exercises the client orchestrator (build, expand, summarize, abort handling, exclusion propagation, stale-marking) against a mock agent layer. Runs in under a second.

## Architecture

- `app/api/agents/*`: three stateless agent endpoints (`search`, `plan`, `rollup`). Each is one LLM or Tavily call with no memory between requests.
- `app/page.tsx` + `components/ResearchApp.tsx`: gated landing and research canvas.
- `components/ResearchGraph.tsx`: React Flow canvas with d3-hierarchy layout.
- `components/NodeCard.tsx`, `components/SidePanel.tsx`: node tile and detail panel.
- `lib/orchestrator.ts`: client-side coordinator. Exposes `buildInitialTree`, `expandNode`, `summarizeSubtree`, `resetAndRebuild`, `markChainStale`.
- `lib/store.ts`: Zustand tree state. Single source of truth for the UI.
- `lib/types.ts`: `ResearchNode`, `Claim`, `ClaimSource`, agent request/response shapes.
- `lib/prompts.ts`: agent system prompts and tool schemas.
- `lib/anthropic.ts`: Anthropic SDK wrapper with tool use and prompt caching.
- `lib/tavily.ts`: Tavily search client.
- `lib/retry.ts`: exponential backoff retry helper (3 attempts on 5xx, 429, network errors).
- `lib/rate-limit.ts`: global cap of 50 Anthropic calls per minute. Process-local.

Tree state lives in the client. The server runs three thin proxies. No SSE, no sessions, no JSON snapshots.

## Models

All three agents use `claude-haiku-4-5-20251001`. System prompts are cached with `cache_control: { type: 'ephemeral' }` to amortize cost across the ~20 calls per session.

Cost ceiling under the cache is around $0.50 to $0.85 per full tree run. Set an Anthropic spending limit before iterating.

## Limits

- 5 concurrent LLM calls in flight at once (`pLimit(5)` in `lib/orchestrator.ts`).
- 50 Anthropic calls per minute, server-global (`lib/rate-limit.ts`). Excess calls wait in line; they don't error.
- 20 nodes per tree (`MAX_TOTAL_NODES` in `lib/orchestrator.ts`).
- 5 login attempts per minute per IP (`/api/auth/route.ts`).
- 12-hour session cookie lifetime.
