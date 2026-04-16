# AGENTS.md

## Repo Instructions

- Treat the current source code as the source of truth for architecture and behavior.
- Use repo-local documentation first when it matches the live code.
- Treat [CLAUDE.md](CLAUDE.md) as a compressed reference, not an authority. It is useful background, but parts of it are stale and some paths no longer match the current tree.
- Treat [webview-ui/README.md](webview-ui/README.md) as boilerplate Vite template text, not project guidance.
- Treat forward-looking sections of [README.md](README.md), especially "Where This Is Going", as product direction rather than current implementation.
- Use Context7 as the first source for external documentation lookup when repo-local code and docs are not enough.
- If Context7 does not provide the needed package, version, or API detail, say that explicitly before falling back elsewhere.
- When summarizing external docs, include the relevant package or tool name and version when Context7 provides it.

## Current Reality

- This repo is **Pixel Agents**, a VS Code extension with an embedded React webview and a local Node hook server.
- The product is **Claude Code-first today**, not Codex-first. The live launch path still starts terminals with `claude --session-id ...`. See [src/agentManager.ts](src/agentManager.ts).
- Session discovery and transcript watching are centered on `~/.claude/projects/...` JSONL files. See [src/agentManager.ts](src/agentManager.ts), [src/fileWatcher.ts](src/fileWatcher.ts), and [src/transcriptParser.ts](src/transcriptParser.ts).
- Hook installation currently targets `~/.claude/settings.json` and copies the bundled hook script into `~/.pixel-agents/hooks/`. See [server/src/providers/hook/claude/claudeHookInstaller.ts](server/src/providers/hook/claude/claudeHookInstaller.ts).
- Hook events are received by the embedded HTTP server and routed through the hook event handler. See [server/src/server.ts](server/src/server.ts) and [server/src/hookEventHandler.ts](server/src/hookEventHandler.ts).
- The extension backend lives in [src](src), the hook/server logic in [server/src](server/src), shared asset helpers in [shared](shared), and the React webview in [webview-ui/src](webview-ui/src).
- Provider abstraction exists, but the only bundled provider in this repo today is Claude. See [server/src/provider.ts](server/src/provider.ts), [server/src/providers/index.ts](server/src/providers/index.ts), and [server/src/providers/hook/claude/claude.ts](server/src/providers/hook/claude/claude.ts).

## Architecture Map

- Extension entry and lifecycle: [src/extension.ts](src/extension.ts)
- Main orchestration surface: [src/PixelAgentsViewProvider.ts](src/PixelAgentsViewProvider.ts)
- Terminal launch, persistence, restore, agent creation/removal: [src/agentManager.ts](src/agentManager.ts)
- Transcript polling, adoption, `/clear` handling, external session scanning: [src/fileWatcher.ts](src/fileWatcher.ts)
- JSONL parsing and activity/status updates: [src/transcriptParser.ts](src/transcriptParser.ts)
- Shared extension agent types: [src/types.ts](src/types.ts)
- Hook server and transport: [server/src/server.ts](server/src/server.ts)
- Hook event routing and buffering: [server/src/hookEventHandler.ts](server/src/hookEventHandler.ts)
- Provider contract and provider-agnostic seams: [server/src/provider.ts](server/src/provider.ts) and [server/src/teamProvider.ts](server/src/teamProvider.ts)
- Claude provider implementation: [server/src/providers/hook/claude/claude.ts](server/src/providers/hook/claude/claude.ts)
- Claude hook install/copy logic: [server/src/providers/hook/claude/claudeHookInstaller.ts](server/src/providers/hook/claude/claudeHookInstaller.ts)
- Bundled hook script source: [server/src/providers/hook/claude/hooks/claude-hook.ts](server/src/providers/hook/claude/hooks/claude-hook.ts)
- Webview app root and message plumbing: [webview-ui/src/App.tsx](webview-ui/src/App.tsx) and [webview-ui/src/hooks/useExtensionMessages.ts](webview-ui/src/hooks/useExtensionMessages.ts)
- Office simulation, layout, and rendering: [webview-ui/src/office](webview-ui/src/office)
- Asset loading and manifest handling: [src/assetLoader.ts](src/assetLoader.ts), [shared/assets](shared/assets), and [webview-ui/public/assets](webview-ui/public/assets)

## Product Direction

- The current shipping product is a pixel-art office that visualizes Claude Code agents in VS Code.
- The longer-term direction is broader and more agent-agnostic, but that future state is not the source of truth for present behavior.
- When deciding between current code and aspirational text, follow the current code.
- When adding abstractions, prefer extending the existing provider boundary instead of scattering new Claude-specific assumptions deeper into shared logic.

## Working Rules

- Before changing behavior, inspect the implementation files that currently own it instead of inferring from old docs.
- For extension lifecycle, panel behavior, asset loading, settings, and command wiring, start with [src/extension.ts](src/extension.ts) and [src/PixelAgentsViewProvider.ts](src/PixelAgentsViewProvider.ts).
- For spawning agents, terminal/session mapping, persistence, and restore flows, start with [src/agentManager.ts](src/agentManager.ts) and [src/types.ts](src/types.ts).
- For transcript-driven state changes, scan/adoption behavior, and timer interactions, start with [src/fileWatcher.ts](src/fileWatcher.ts), [src/transcriptParser.ts](src/transcriptParser.ts), and [src/timerManager.ts](src/timerManager.ts).
- For hook protocol, server auth/discovery, and event routing, start with [server/src/server.ts](server/src/server.ts), [server/src/hookEventHandler.ts](server/src/hookEventHandler.ts), and [server/src/constants.ts](server/src/constants.ts).
- For Claude-specific hook payloads, launch commands, session-dir resolution, and tool-status formatting, start with [server/src/providers/hook/claude/claude.ts](server/src/providers/hook/claude/claude.ts).
- For hook installation and copied script behavior, start with [server/src/providers/hook/claude/claudeHookInstaller.ts](server/src/providers/hook/claude/claudeHookInstaller.ts) and [server/src/providers/hook/claude/hooks/claude-hook.ts](server/src/providers/hook/claude/hooks/claude-hook.ts).
- For React/webview behavior, inspect [webview-ui/src/App.tsx](webview-ui/src/App.tsx), [webview-ui/src/hooks](webview-ui/src/hooks), and the relevant files under [webview-ui/src/office](webview-ui/src/office) before changing UI flows.
- For office assets or manifests, inspect [docs/external-assets.md](docs/external-assets.md), [src/assetLoader.ts](src/assetLoader.ts), and the relevant files in [shared/assets](shared/assets) and [webview-ui/public/assets](webview-ui/public/assets).
- Preserve provider-agnostic abstractions where they already exist. If a change is Claude-only, keep that logic inside the Claude provider or clearly Claude-scoped modules.
- Keep this file aligned with the live repo. If implementation paths or ownership boundaries change, update this file.

## Build And Test

- Install dependencies from the repo root, then separately in [webview-ui](webview-ui) and [server](server) as needed.
- Main build: `npm run build`
- Type-check only: `npm run check-types`
- Lint: `npm run lint`
- Full test suite: `npm test`
- Server tests: `npm run test:server`
- Webview tests: `npm run test:webview`
- End-to-end tests: `npm run e2e`

## Practical Notes

- Expect historical naming around "Claude" in files, tests, and docs; many of those references are still correct for the live implementation.
- Do not assume the provider abstraction is fully generalized just because the interfaces mention other providers.
- If a doc and the code disagree on a path or workflow, trust the code and then update the doc.
