import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  TERMINAL_NAME_PREFIX,
  WORKSPACE_KEY_AGENT_SEATS,
  WORKSPACE_KEY_AGENTS,
} from './constants.js';
import { migrateAndLoadLayout } from './layoutPersistence.js';
import { safeUpdateState } from './stateUtils.js';
import { cancelPermissionTimer, cancelWaitingTimer } from './timerManager.js';
import type { AgentState, PersistedAgent } from './types.js';

export interface CreateManagedAgentOptions {
  folderPath?: string;
  displayName?: string;
  initialPrompt?: string;
  folderName?: string;
  orchestrationRunId?: string;
  workspaceAssignmentId?: string;
}

export function getProjectDirPath(cwd?: string): string {
  const workspacePath = cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
  const dirName = workspacePath.replace(/[^a-zA-Z0-9-]/g, '-');
  const projectDir = path.join(os.homedir(), '.codex', 'projects', dirName);
  console.log(`[Pixel Agents] Terminal: Project dir: ${workspacePath} → ${dirName}`);

  if (!fs.existsSync(projectDir)) {
    const projectsRoot = path.join(os.homedir(), '.codex', 'projects');
    try {
      if (fs.existsSync(projectsRoot)) {
        const candidates = fs.readdirSync(projectsRoot);
        const lowerDirName = dirName.toLowerCase();
        const match = candidates.find((c) => c.toLowerCase() === lowerDirName);
        if (match && match !== dirName) {
          const matchedDir = path.join(projectsRoot, match);
          return matchedDir;
        }
      }
    } catch {
      // Ignore scan errors
    }
  }
  return projectDir;
}

function buildCodexLaunchCommand(bypassPermissions = false): string {
  return bypassPermissions ? 'codex --dangerously-bypass-approvals-and-sandbox' : 'codex';
}

export function launchAgentInTerminal(
  agent: AgentState,
  bypassPermissions = false,
): vscode.Terminal {
  const terminal = vscode.window.createTerminal({
    name: `${TERMINAL_NAME_PREFIX} #${agent.id}`,
    cwd: agent.cwd,
  });
  agent.terminalRef = terminal;
  terminal.show(true);
  terminal.sendText(buildCodexLaunchCommand(bypassPermissions), true);
  console.log(`[Pixel Agents] Session: Agent ${agent.id} - launched in VS Code terminal`);
  return terminal;
}

export async function launchNewTerminal(
  nextAgentIdRef: { current: number },
  _nextTerminalIndexRef: { current: number },
  agents: Map<number, AgentState>,
  webview: vscode.Webview | undefined,
  persistAgents: () => void,
  options: CreateManagedAgentOptions = {},
): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  const cwd = options.folderPath || folders?.[0]?.uri.fsPath || os.homedir();
  const isMultiRoot = !!(folders && folders.length > 1);

  const projectDir = getProjectDirPath(cwd);

  const id = nextAgentIdRef.current++;
  const folderName = options.folderName || (isMultiRoot && cwd ? path.basename(cwd) : undefined);
  const agent: AgentState = {
    id,
    // Leave sessionId empty — hookEventHandler will fill it in when SessionStart fires
    sessionId: '',
    displayName: options.displayName,
    initialPrompt: options.initialPrompt,
    cwd,
    isExternal: false,
    projectDir,
    activeToolIds: new Set(),
    activeToolStatuses: new Map(),
    activeToolNames: new Map(),
    activeSubagentToolIds: new Map(),
    activeSubagentToolNames: new Map(),
    backgroundAgentToolIds: new Set(),
    isWaiting: false,
    permissionSent: false,
    hadToolsInTurn: false,
    folderName,
    orchestrationRunId: options.orchestrationRunId,
    workspaceAssignmentId: options.workspaceAssignmentId,
    hookDelivered: false,
  };

  agents.set(id, agent);
  persistAgents();
  console.log(`[Pixel Agents] Session: Agent ${id} - created for managed runtime`);
  webview?.postMessage({ type: 'agentCreated', id, folderName, displayName: options.displayName });
}

export function removeAgent(
  agentId: number,
  agents: Map<number, AgentState>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  persistAgents: () => void,
): void {
  const agent = agents.get(agentId);
  if (!agent) return;

  cancelWaitingTimer(agentId, waitingTimers);
  cancelPermissionTimer(agentId, permissionTimers);

  agents.delete(agentId);
  persistAgents();
}

export function persistAgents(
  agents: Map<number, AgentState>,
  context: vscode.ExtensionContext,
): void {
  const persisted: PersistedAgent[] = [];
  for (const agent of agents.values()) {
    persisted.push({
      id: agent.id,
      sessionId: agent.sessionId,
      displayName: agent.displayName,
      initialPrompt: agent.initialPrompt,
      terminalName: agent.terminalRef?.name ?? '',
      isExternal: agent.isExternal || undefined,
      projectDir: agent.projectDir,
      cwd: agent.cwd,
      orchestrationRunId: agent.orchestrationRunId,
      workspaceAssignmentId: agent.workspaceAssignmentId,
      folderName: agent.folderName,
    });
  }
  safeUpdateState(context.workspaceState, WORKSPACE_KEY_AGENTS, persisted);
}

export function restoreAgents(
  context: vscode.ExtensionContext,
  nextAgentIdRef: { current: number },
  _nextTerminalIndexRef: { current: number },
  agents: Map<number, AgentState>,
  doPersist: () => void,
): void {
  const persisted = context.workspaceState.get<PersistedAgent[]>(WORKSPACE_KEY_AGENTS, []);
  if (persisted.length === 0) return;

  let maxId = 0;

  for (const p of persisted) {
    if (agents.has(p.id)) {
      continue;
    }

    const isExternal = p.isExternal ?? false;

    if (!isExternal) {
      continue;
    }

    const agent: AgentState = {
      id: p.id,
      sessionId: p.sessionId || `session-${p.id}`,
      displayName: p.displayName,
      initialPrompt: p.initialPrompt,
      isExternal,
      projectDir: p.projectDir,
      cwd: p.cwd,
      activeToolIds: new Set(),
      activeToolStatuses: new Map(),
      activeToolNames: new Map(),
      activeSubagentToolIds: new Map(),
      activeSubagentToolNames: new Map(),
      backgroundAgentToolIds: new Set(),
      isWaiting: false,
      permissionSent: false,
      hadToolsInTurn: false,
      folderName: p.folderName,
      orchestrationRunId: p.orchestrationRunId,
      workspaceAssignmentId: p.workspaceAssignmentId,
      hookDelivered: false,
    };

    agents.set(p.id, agent);
    console.log(`[Pixel Agents] Session: Agent ${p.id} - restored external`);

    if (p.id > maxId) maxId = p.id;
  }

  if (maxId >= nextAgentIdRef.current) {
    nextAgentIdRef.current = maxId + 1;
  }

  doPersist();
}

export function sendExistingAgents(
  agents: Map<number, AgentState>,
  context: vscode.ExtensionContext,
  webview: vscode.Webview | undefined,
): void {
  if (!webview) return;
  const agentIds: number[] = [];
  for (const id of agents.keys()) {
    agentIds.push(id);
  }
  agentIds.sort((a, b) => a - b);

  const agentMeta = context.workspaceState.get<
    Record<string, { palette?: number; seatId?: string }>
  >(WORKSPACE_KEY_AGENT_SEATS, {});

  const folderNames: Record<number, string> = {};
  const externalAgents: Record<number, boolean> = {};
  for (const [id, agent] of agents) {
    if (agent.folderName) {
      folderNames[id] = agent.folderName;
    }
    if (agent.isExternal) {
      externalAgents[id] = true;
    }
  }
  console.log(
    `[Pixel Agents] sendExistingAgents: agents=${JSON.stringify(agentIds)}, meta=${JSON.stringify(agentMeta)}`,
  );

  webview.postMessage({
    type: 'existingAgents',
    agents: agentIds,
    agentMeta,
    folderNames,
    externalAgents,
  });
}

export function sendCurrentAgentStatuses(
  agents: Map<number, AgentState>,
  webview: vscode.Webview | undefined,
): void {
  if (!webview) return;
  for (const [agentId, agent] of agents) {
    for (const [toolId, status] of agent.activeToolStatuses) {
      const toolName = agent.activeToolNames.get(toolId) ?? '';
      webview.postMessage({
        type: 'agentToolStart',
        id: agentId,
        toolId,
        status,
        toolName,
      });
    }
    if (agent.isWaiting) {
      webview.postMessage({
        type: 'agentStatus',
        id: agentId,
        status: 'waiting',
      });
    }
  }
}

export function sendLayout(
  context: vscode.ExtensionContext,
  webview: vscode.Webview | undefined,
  defaultLayout?: Record<string, unknown> | null,
): void {
  if (!webview) return;
  const result = migrateAndLoadLayout(context, defaultLayout);
  webview.postMessage({
    type: 'layoutLoaded',
    layout: result?.layout ?? null,
    wasReset: result?.wasReset ?? false,
  });
}
