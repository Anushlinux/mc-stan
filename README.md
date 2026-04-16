# Pixel Agents for Codex

- Fork publishers: Rajdeep Pandey and Anushrut Pandit
- Original upstream repository: https://github.com/pablodelucca/pixel-agents

## Fork Notice

This codebase was forked from Pablo Delucca's Pixel Agents using GitHub's fork feature, and this README explicitly labels that origin.

The original project was built around Claude Code. This fork keeps the pixel office UX, but changes the live extension behavior to work with Codex-first workflows inside VS Code.

This is not a claim that the original project was designed for Codex. The Codex runtime, session handling, hook installation, Mission Control state model, and master orchestration flow described below are the main additions and retargeting work in this fork.

## What This Fork Does

Pixel Agents for Codex turns Codex sessions into visible characters inside a pixel-art VS Code panel.

In the live code today:

- Each visible agent maps to a stateful Codex session.
- Managed agents launch with the `codex` CLI.
- Session state is tracked through a local hook server plus Mission Control state persisted in the extension workspace.
- The extension can monitor approvals, waiting states, tool activity, token usage, artifacts, and task ownership.
- A master orchestrator can take one operator brief, split it into a fixed 3-worker plan, create isolated git worktrees, launch 3 worker Codex sessions, and guide review/apply back into the main checkout.

## What Changed From Upstream

The upstream repo was Claude-first. This fork is Codex-first in the live launch path:

- Agent launch uses `codex` and optional `--dangerously-bypass-approvals-and-sandbox`.
- Project/session discovery is rooted in `~/.codex/projects/...`.
- Hook installation targets `~/.codex/settings.json`.
- The bundled hook script is copied to `~/.pixel-agents/hooks/codex-hook.js`.
- Hook events are delivered to a local HTTP server inside the extension and routed into session state.
- Mission Control persists structured state for sessions, tasks, approvals, artifacts, workspaces, briefings, and orchestration progress.
- The master agent flow is no longer just visual language. It is implemented as a real orchestrator that provisions worktrees and launches worker Codex sessions.

## Core Features

- Stateful Codex agents: every managed character is backed by a real Codex session with its own session id, cwd, project/worktree mapping, and live lifecycle state.
- Pixel office visualization: agents move, animate, and show active, waiting, blocked, and approval-related states in the webview.
- Mission Control: the extension stores structured snapshots for sessions, tasks, approvals, events, artifacts, token usage, workspaces, and orchestrator progress.
- Sub-agent visibility: subtask and agent delegation events are surfaced in the office as linked child activity.
- Interactive session monitoring: managed sessions use the embedded/native terminal bridge so the extension can inspect and interact with running Codex terminals.
- Approval tracking: permission requests are classified by scope and risk and surfaced through Mission Control.
- Externalized office customization: layouts, floors, walls, furniture, and external asset directories remain part of the experience.
- Master orchestration: one top-level brief can be planned, split, launched, reviewed, and applied across three isolated worker sessions.

## How The Codex Runtime Works

The current flow in this fork is:

1. The VS Code extension starts a local HTTP hook server on `127.0.0.1` and writes discovery info to `~/.pixel-agents/server.json`.
2. If hooks are enabled, the extension installs Codex hook entries into `~/.codex/settings.json` and copies the hook script into `~/.pixel-agents/hooks/codex-hook.js`.
3. When you create an agent, the extension creates a managed agent record first, including cwd, project directory, orchestration metadata, and empty session binding.
4. The extension launches `codex` in a managed terminal session.
5. When Codex emits `SessionStart`, the hook event handler claims the pending agent by cwd, binds the real `session_id`, and starts live tracking.
6. Tool, approval, notification, stop, subagent, and session-end hook events are forwarded to both the office UI and Mission Control.
7. Mission Control persists the structured session snapshot in workspace state so the extension keeps long-lived context for tasks and reviews.

## Why "Each Agent Is Stateful" In This Fork

That claim is backed by the implementation, not just the UI.

Each session tracked in Mission Control carries structured state such as:

- provider
- session id
- agent id
- cwd and project/worktree location
- current status
- current and last tool
- blocker reason
- approval count
- artifact count
- token usage
- linked task and workspace assignment

Mission Control also keeps:

- task records
- approval requests and decisions
- event timelines
- produced artifacts
- worktree assignments
- orchestrator plans and progress
- active session lookup by agent id

So these are not stateless animated sprites. They are persistent tracked Codex sessions with attached operational state.

## Master Agent / Master Orchestrator

This fork includes a real master orchestration flow.

Important implementation detail: the master does not directly code. It plans and coordinates. The current implementation fans work out into a fixed 3-worker split.

The master flow works like this:

1. The operator enters a high-level prompt in the Master Orchestrator panel.
2. The extension resolves the repository root and active branch.
3. The repo must have a clean tracked working tree before orchestration starts.
4. The local planner analyzes the repository layout and produces exactly 3 non-overlapping worker assignments.
5. Each worker gets owned paths, acceptance criteria, coordination notes, and a dedicated git worktree.
6. Worktrees are provisioned under `~/.pixel-agents/worktrees/<repo>/<run>/agent-1..3`.
7. The extension launches Worker 1, Worker 2, and Worker 3 as separate Codex sessions with assignment-specific prompts.
8. Mission Control tracks the full run, including phase progress, worker tasks, workspace assignments, and when the team becomes quiescent.
9. The UI can load a review for one worker or a combined team review by diffing each worker worktree against the main checkout.
10. Approved worker changes can be applied back into the main checkout from the review UI.

So the "master chief agent" in this fork is best described as a master orchestrator that takes a task, plans a 3-way split, spawns multiple Codex sessions, and makes session management and review easier.

## Mission Control

Mission Control is the operational layer behind the office.

It tracks:

- sessions and lifecycle state
- tasks and ownership
- pending approvals
- artifacts such as files, commands, delegations, and summaries
- event history
- workspace assignments
- briefing metadata
- orchestrator phases and progress

This lets the extension surface:

- who is active
- who is blocked
- who needs approval
- what changed
- which workspace or worktree belongs to which worker
- when the full team is ready for review

## Review And Apply Flow

The master workflow is not only about spawning workers. It also includes controlled integration:

- Worker review loads a diff only for that worker's owned paths.
- Team review aggregates all worker worktree diffs.
- Approve And Apply copies reviewed worker changes from the isolated worktree back into the main checkout.
- The main checkout must stay clean in tracked owned paths before apply.

This keeps the split explicit and makes the handoff back to the main repo understandable.

## UI Highlights

- Pixel office canvas with animated agents
- Mission Control modal for overview, dispatch, master orchestration, and agent inspection
- Master Agent launcher in the office UI
- Worker review and team review modals
- Embedded/native terminal inspection for managed sessions
- Layout editor and asset loading for the office environment

## Requirements

- VS Code 1.105.0 or later
- Codex CLI installed and configured
- Git available locally
- Node.js and npm for building from source

## Getting Started

```bash
git clone https://github.com/<your-account>/mc-stan.git
cd mc-stan
npm install
cd webview-ui && npm install && cd ..
cd server && npm install && cd ..
npm run build
```

Then press `F5` in VS Code to launch the Extension Development Host.

## Using The Extension

1. Open the Pixel Agents panel in VS Code.
2. Create an agent to launch a managed Codex session.
3. Watch the character reflect live activity and hook-driven status changes.
4. Open Mission Control to inspect tasks, approvals, and session state.
5. Use the Master Agent to brief the orchestrator and launch the 3-worker Codex run.
6. Review worker diffs or the combined team review before applying changes back to the main checkout.

## Current Positioning

This fork should be understood as:

- a clearly labeled GitHub fork of the original Pixel Agents project
- a Codex-adapted version of that idea
- a VS Code extension that visualizes and manages stateful Codex sessions
- a hackathon fork with added master/worker orchestration and review flow

It should not be described as the original upstream project, and it should not be described as if Codex support was the original design target. That is exactly what this fork changes.

## Acknowledgements

- Original project and concept: Pablo Delucca, Pixel Agents
- Original upstream repo: https://github.com/pablodelucca/pixel-agents
- Character art attribution retained from upstream: JIK-A-4, Metro City

## License

This repository inherits the upstream MIT License. See [LICENSE](LICENSE).
