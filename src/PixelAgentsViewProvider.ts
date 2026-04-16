import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import type { HookEvent } from '../server/src/hookEventHandler.js';
import { HookEventHandler } from '../server/src/hookEventHandler.js';
import {
  copyHookScript,
  installHooks,
  uninstallHooks,
} from '../server/src/providers/file/codexHookInstaller.js';
import { PixelAgentsServer } from '../server/src/server.js';
import type { EmbeddedTerminalSnapshot } from '../shared/embeddedTerminal.js';
import type { MissionControlTask } from '../shared/missionControl.js';
import {
  type CreateManagedAgentOptions,
  getProjectDirPath,
  launchNewTerminal,
  persistAgents,
  removeAgent,
  restoreAgents,
  sendCurrentAgentStatuses,
  sendExistingAgents,
  sendLayout,
} from './agentManager.js';
import type { LoadedAssets, LoadedCharacterSprites } from './assetLoader.js';
import {
  loadCharacterSprites,
  loadDefaultLayout,
  loadExternalCharacterSprites,
  loadFloorTiles,
  loadFurnitureAssets,
  loadWallTiles,
  mergeCharacterSprites,
  mergeLoadedAssets,
  sendAssetsToWebview,
  sendCharacterSpritesToWebview,
  sendFloorTilesToWebview,
  sendWallTilesToWebview,
} from './assetLoader.js';
import { readConfig, writeConfig } from './configPersistence.js';
import {
  COMMAND_SHOW_PANEL,
  GLOBAL_KEY_ALWAYS_SHOW_LABELS,
  GLOBAL_KEY_HOOKS_ENABLED,
  GLOBAL_KEY_HOOKS_INFO_SHOWN,
  GLOBAL_KEY_LAST_SEEN_VERSION,
  GLOBAL_KEY_SOUND_ENABLED,
  GLOBAL_KEY_WATCH_ALL_SESSIONS,
  LAYOUT_REVISION_KEY,
  TERMINAL_NAME_PREFIX,
  WORKSPACE_KEY_AGENT_SEATS,
} from './constants.js';
import {
  createInspectOnlyTerminalSnapshot,
  EmbeddedTerminalManager,
} from './embeddedTerminalManager.js';
import type { LayoutWatcher } from './layoutPersistence.js';
import { readLayoutFromFile, watchLayoutFile, writeLayoutToFile } from './layoutPersistence.js';
import { MasterOrchestrator, type MasterPlannerAssignment } from './masterOrchestrator.js';
import { type CreateTaskOptions, MissionControlStore } from './missionControlStore.js';
import { NativeTerminalManager } from './nativeTerminalManager.js';
import { safeUpdateState } from './stateUtils.js';
import type { AgentState } from './types.js';
import { VoiceDictationManager } from './voiceDictationManager.js';
import { WorktreeManager, type WorktreeReview } from './worktreeManager.js';

interface CreateAgentSessionOptions extends CreateManagedAgentOptions {
  bypassPermissions?: boolean;
  taskInput?: {
    title?: string;
    goal: string;
    priority?: MissionControlTask['priority'];
    acceptanceCriteria?: string[];
    constraints?: string[];
    expectedArtifacts?: string[];
  };
  taskOptions?: CreateTaskOptions;
}

export class PixelAgentsViewProvider implements vscode.WebviewViewProvider {
  nextAgentId = { current: 1 };
  nextTerminalIndex = { current: 1 };
  agents = new Map<number, AgentState>();
  webviewView: vscode.WebviewView | undefined;

  waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
  permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();

  activeAgentId = { current: null as number | null };

  watchAllSessions = { current: false };
  hooksEnabled = { current: true };

  defaultLayout: Record<string, unknown> | null = null;
  private assetsRoot: string | null = null;
  layoutWatcher: LayoutWatcher | null = null;

  private pixelAgentsServer: PixelAgentsServer | null = null;
  private hookEventHandler: HookEventHandler | null = null;
  private embeddedTerminalManager: EmbeddedTerminalManager;
  private masterOrchestrator: MasterOrchestrator;
  private nativeTerminalManager: NativeTerminalManager;
  private missionControlStore: MissionControlStore;
  private missionControlUnsubscribe: (() => void) | null = null;
  private voiceDictationManager: VoiceDictationManager;
  private worktreeManager: WorktreeManager;
  private webviewReady = false;
  private pendingVoiceDictationToggle = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.embeddedTerminalManager = new EmbeddedTerminalManager({
      onData: (agentId, data) => {
        this.webview?.postMessage({ type: 'terminalData', agentId, data });
      },
      onSnapshot: (agentId, snapshot) => {
        this.postTerminalSnapshot(agentId, snapshot);
      },
      onExit: (agentId, details) => {
        const agent = this.agents.get(agentId);
        if (!agent) return;

        if (this.shouldTreatManagedExitAsLaunchFailure(agent, details.reason)) {
          this.missionControlStore.recordAgentLaunchFailure(agent, details.reason);
          void vscode.window.showErrorMessage(
            `Mission Control: Agent #${agentId} failed to start. ${details.reason}`,
          );
          return;
        }

        this.removeManagedAgent(agentId, details.reason);
      },
    });
    this.nativeTerminalManager = new NativeTerminalManager({
      onData: (agentId, data) => {
        this.webview?.postMessage({ type: 'terminalData', agentId, data });
      },
      onSnapshot: (agentId, snapshot) => {
        this.postTerminalSnapshot(agentId, snapshot);
      },
      onExit: (agentId, details) => {
        const agent = this.agents.get(agentId);
        if (!agent) return;

        if (this.shouldTreatManagedExitAsLaunchFailure(agent, details.reason)) {
          this.handleAgentLaunchFailure(agentId, details.reason);
          return;
        }

        this.removeManagedAgent(agentId, details.reason);
      },
    });
    this.missionControlStore = new MissionControlStore(context);
    this.masterOrchestrator = new MasterOrchestrator();
    this.missionControlUnsubscribe = this.missionControlStore.subscribe((snapshot) => {
      this.webview?.postMessage({ type: 'missionControlSnapshot', snapshot });
    });
    this.voiceDictationManager = new VoiceDictationManager({
      extensionPath: context.extensionPath,
      onText: async (text) => {
        await this.insertVoiceDictationText(text);
      },
    });
    this.worktreeManager = new WorktreeManager();
    this.initHooks();
  }

  private get extensionUri(): vscode.Uri {
    return this.context.extensionUri;
  }

  private get webview(): vscode.Webview | undefined {
    return this.webviewView?.webview;
  }

  private get useNativeTerminalBridge(): boolean {
    // The hidden shell-integration bridge is reliable on Windows, but on macOS it can
    // terminate Codex immediately with exit code 130 before the session is adopted.
    return process.platform === 'win32';
  }

  private persistAgents = (): void => {
    persistAgents(this.agents, this.context);
  };

  private shouldTreatManagedExitAsLaunchFailure(agent: AgentState, reason: string): boolean {
    if (agent.sessionId) {
      return false;
    }

    if (agent.hookDelivered) {
      return false;
    }

    return !reason.startsWith('Session ended');
  }

  private hasManagedTerminalSession(agentId: number): boolean {
    return this.useNativeTerminalBridge
      ? this.nativeTerminalManager.hasSession(agentId)
      : this.embeddedTerminalManager.hasSession(agentId);
  }

  private getManagedTerminalSnapshot(agentId: number): EmbeddedTerminalSnapshot | undefined {
    return this.useNativeTerminalBridge
      ? this.nativeTerminalManager.getSnapshot(agentId)
      : this.embeddedTerminalManager.getSnapshot(agentId);
  }

  private sendManagedTerminalInput(agentId: number, data: string): boolean {
    return this.useNativeTerminalBridge
      ? this.nativeTerminalManager.sendInput(agentId, data)
      : this.embeddedTerminalManager.sendInput(agentId, data);
  }

  private sendManagedTerminalLine(agentId: number, text: string): boolean {
    return this.useNativeTerminalBridge
      ? this.nativeTerminalManager.sendLine(agentId, text)
      : this.embeddedTerminalManager.sendLine(agentId, text);
  }

  private interruptManagedTerminal(agentId: number): boolean {
    return this.useNativeTerminalBridge
      ? this.nativeTerminalManager.interrupt(agentId)
      : this.embeddedTerminalManager.interrupt(agentId);
  }

  private resizeManagedTerminal(
    agentId: number,
    cols: number,
    rows: number,
  ): EmbeddedTerminalSnapshot | undefined {
    return this.useNativeTerminalBridge
      ? this.nativeTerminalManager.resize(agentId, cols, rows)
      : this.embeddedTerminalManager.resize(agentId, cols, rows);
  }

  private disposeManagedTerminalSession(agentId: number): void {
    if (this.useNativeTerminalBridge) {
      this.nativeTerminalManager.disposeSession(agentId);
      return;
    }

    this.embeddedTerminalManager.disposeSession(agentId);
  }

  private shouldAutoCreateNativeMasterSession(): boolean {
    if (process.platform !== 'win32') {
      return false;
    }

    for (const agent of this.agents.values()) {
      if (!agent.isExternal) {
        return false;
      }
    }

    return true;
  }

  private removeManagedAgent(
    agentId: number,
    reason: string,
    options?: { disposeTerminal?: boolean },
  ): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    if (this.activeAgentId.current === agentId) {
      this.activeAgentId.current = null;
    }

    if (options?.disposeTerminal && agent.terminalRef) {
      const terminal = agent.terminalRef;
      agent.terminalRef = undefined;
      try {
        terminal.dispose();
      } catch {
        // Ignore terminal teardown errors during cleanup.
      }
    }

    if (this.useNativeTerminalBridge && agent.terminalRef) {
      agent.terminalRef = undefined;
    }

    this.disposeManagedTerminalSession(agentId);
    this.missionControlStore.recordAgentRemoved(agent, reason);
    this.unregisterAgentHook(agent);
    removeAgent(
      agentId,
      this.agents,
      this.waitingTimers,
      this.permissionTimers,
      this.persistAgents,
    );
    this.webview?.postMessage({ type: 'agentClosed', id: agentId });
  }

  private handleAgentLaunchFailure(agentId: number, reason: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    if (this.activeAgentId.current === agentId) {
      this.activeAgentId.current = null;
    }

    if (this.useNativeTerminalBridge && agent.terminalRef) {
      agent.terminalRef = undefined;
    }

    this.disposeManagedTerminalSession(agentId);
    this.unregisterAgentHook(agent);
    this.missionControlStore.recordAgentLaunchFailure(agent, reason);
    removeAgent(
      agentId,
      this.agents,
      this.waitingTimers,
      this.permissionTimers,
      this.persistAgents,
    );
    this.webview?.postMessage({ type: 'agentClosed', id: agentId });
    void vscode.window.showErrorMessage(
      `Mission Control: Agent #${agentId} failed to start. ${reason}`,
    );
  }

  private postTerminalSnapshot(agentId: number, snapshot: EmbeddedTerminalSnapshot): void {
    this.webview?.postMessage({
      type: 'terminalSnapshot',
      agentId,
      snapshot,
    });
  }

  private syncTerminalSnapshot(agent: AgentState): void {
    if (agent.isExternal) {
      this.postTerminalSnapshot(
        agent.id,
        createInspectOnlyTerminalSnapshot(
          'External sessions can be inspected here, but interactive takeover is only available for agents launched from this workspace.',
        ),
      );
      return;
    }

    if (agent.terminalRef) {
      const snapshot =
        this.getManagedTerminalSnapshot(agent.id) ??
        createInspectOnlyTerminalSnapshot(
          'The hidden terminal bridge is unavailable for this session.',
          undefined,
          undefined,
          'unavailable',
          'native_terminal',
        );
      this.postTerminalSnapshot(agent.id, snapshot);
      return;
    }

    const snapshot =
      this.getManagedTerminalSnapshot(agent.id) ??
      createInspectOnlyTerminalSnapshot('Embedded terminal is unavailable for this session.');
    this.postTerminalSnapshot(agent.id, snapshot);
  }

  private syncAllTerminalSnapshots(): void {
    for (const agent of this.agents.values()) {
      this.syncTerminalSnapshot(agent);
    }
  }

  private buildAgentLaunchArgs(agent: AgentState, bypassPermissions = false): string[] {
    const args: string[] = [];
    if (bypassPermissions) {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    }
    if (agent.initialPrompt?.trim()) {
      args.push(agent.initialPrompt.trim());
    }
    return args;
  }

  private launchNativeAgentRuntime(agent: AgentState, bypassPermissions = false): void {
    try {
      const { terminal, snapshot } = this.nativeTerminalManager.launchSession({
        agentId: agent.id,
        cwd: agent.cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir(),
        name: agent.displayName
          ? `${TERMINAL_NAME_PREFIX} #${agent.id} · ${agent.displayName}`
          : `${TERMINAL_NAME_PREFIX} #${agent.id}`,
        command: 'codex',
        args: this.buildAgentLaunchArgs(agent, bypassPermissions),
      });
      agent.terminalRef = terminal;
      this.postTerminalSnapshot(agent.id, snapshot);
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : 'Failed to launch the hidden terminal bridge.';
      this.handleAgentLaunchFailure(agent.id, reason);
    }
  }

  private launchEmbeddedAgentRuntime(agent: AgentState, bypassPermissions = false): void {
    const snapshot = this.embeddedTerminalManager.launchSession({
      agentId: agent.id,
      cwd: agent.cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir(),
      command: 'codex',
      args: this.buildAgentLaunchArgs(agent, bypassPermissions),
    });
    this.postTerminalSnapshot(agent.id, snapshot);
  }

  private launchAgentRuntime(agent: AgentState, bypassPermissions = false): void {
    if (this.useNativeTerminalBridge) {
      this.launchNativeAgentRuntime(agent, bypassPermissions);
      return;
    }

    this.launchEmbeddedAgentRuntime(agent, bypassPermissions);
  }

  private async createAgentSession(
    options: CreateAgentSessionOptions = {},
  ): Promise<{ agent?: AgentState; task?: MissionControlTask }> {
    const prevAgentIds = new Set(this.agents.keys());
    await launchNewTerminal(
      this.nextAgentId,
      this.nextTerminalIndex,
      this.agents,
      this.webview,
      this.persistAgents,
      options,
    );

    let createdAgent: AgentState | undefined;
    let task: MissionControlTask | undefined;

    for (const [id, agent] of this.agents) {
      if (prevAgentIds.has(id)) {
        continue;
      }

      createdAgent = agent;
      this.registerAgentHook(agent);
      this.missionControlStore.recordAgentLaunch(agent);
      if (options.taskInput) {
        task = this.missionControlStore.submitTask(options.taskInput, agent, options.taskOptions);
      }
      this.launchAgentRuntime(agent, options.bypassPermissions);
    }

    return { agent: createdAgent, task };
  }

  private buildTaskDispatchPrompt(task: MissionControlTask): string {
    const parts = [`Mission Control task: ${task.goal.trim()}`];

    if (task.constraints.length > 0) {
      parts.push(`Constraints: ${task.constraints.join('; ')}`);
    }

    if (task.acceptanceCriteria.length > 0) {
      parts.push(`Acceptance criteria: ${task.acceptanceCriteria.join('; ')}`);
    }

    if (task.expectedArtifacts.length > 0) {
      parts.push(`Expected artifacts: ${task.expectedArtifacts.join('; ')}`);
    }

    if (task.ownedPaths.length > 0) {
      parts.push(`Owned repo paths: ${task.ownedPaths.join('; ')}`);
    }

    parts.push('If blocked, state the blocker and the smallest next input or approval needed.');

    return parts.join(' | ');
  }

  private buildWorkerInitialPrompt(
    operatorPrompt: string,
    planSummary: string,
    assignment: MasterPlannerAssignment,
    worktreePath: string,
    branchName: string,
    sharedConstraints: string[],
  ): string {
    const parts = [
      `You are Worker ${assignment.slot} for a coordinated 3-session implementation run.`,
      `Operator request: ${operatorPrompt.trim()}`,
      `Team plan summary: ${planSummary.trim()}`,
      `Your assignment title: ${assignment.title}`,
      `Your goal: ${assignment.goal}`,
      `Your worktree: ${worktreePath}`,
      `Your branch: ${branchName}`,
      `Owned repo paths: ${assignment.ownedPaths.join(', ')}`,
      'Execution rules: only edit files inside your owned repo paths, do not merge branches, do not reassign work, and report blockers clearly.',
      'If you need something outside your ownership, stop and explain the blocker instead of editing it yourself.',
    ];

    if (sharedConstraints.length > 0) {
      parts.push(`Shared constraints: ${sharedConstraints.join('; ')}`);
    }
    if (assignment.acceptanceCriteria.length > 0) {
      parts.push(`Acceptance criteria: ${assignment.acceptanceCriteria.join('; ')}`);
    }
    if (assignment.coordinationNotes.length > 0) {
      parts.push(`Coordination notes: ${assignment.coordinationNotes.join('; ')}`);
    }
    if (assignment.dependsOnSlots.length > 0) {
      parts.push(
        `Dependencies: wait for updates from worker slots ${assignment.dependsOnSlots.join(', ')} if needed.`,
      );
    }

    return parts.join('\n');
  }

  private getConfiguredProjectDirectories(): string[] {
    return readConfig().projectDirectories;
  }

  private getKnownWorkingDirectories(): string[] {
    const seen = new Set<string>();
    const directories: string[] = [];

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const folderPath = folder.uri.fsPath;
      if (seen.has(folderPath)) {
        continue;
      }
      seen.add(folderPath);
      directories.push(folderPath);
    }

    for (const projectDirectory of this.getConfiguredProjectDirectories()) {
      if (seen.has(projectDirectory)) {
        continue;
      }
      seen.add(projectDirectory);
      directories.push(projectDirectory);
    }

    return directories;
  }

  private async resolveWorkingDirectory(
    preferredPath: string | undefined,
    dialogLabel: string,
  ): Promise<string | undefined> {
    const trimmedPath = preferredPath?.trim();
    if (trimmedPath) {
      if (!fs.existsSync(trimmedPath)) {
        void vscode.window.showWarningMessage(
          `Pixel Agents: Working directory not found: ${trimmedPath}`,
        );
      } else {
        return trimmedPath;
      }
    }

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceRoot && fs.existsSync(workspaceRoot)) {
      return workspaceRoot;
    }

    const configured = this.getConfiguredProjectDirectories().filter((directory) =>
      fs.existsSync(directory),
    );
    if (configured.length === 1) {
      return configured[0];
    }

    const uris = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: dialogLabel,
    });
    return uris?.[0]?.fsPath;
  }

  private postProjectDirectoriesUpdated(): void {
    this.webview?.postMessage({
      type: 'projectDirectoriesUpdated',
      dirs: this.getConfiguredProjectDirectories(),
    });
  }

  private async startMasterOrchestration(message: {
    prompt: string;
    extraConstraints?: string[];
    folderPath?: string;
  }): Promise<void> {
    const operatorPrompt = (message.prompt ?? '').trim();
    if (!operatorPrompt) {
      void vscode.window.showWarningMessage('Master orchestrator: prompt is required.');
      return;
    }

    const orchestrator = this.missionControlStore.getSnapshot().orchestrator;
    if (
      orchestrator.status === 'planning' ||
      orchestrator.status === 'provisioning' ||
      orchestrator.status === 'dispatching' ||
      orchestrator.status === 'running'
    ) {
      void vscode.window.showWarningMessage(
        'Master orchestrator is already running. Wait for the current plan to finish provisioning.',
      );
      return;
    }

    const workspaceRoot = await this.resolveWorkingDirectory(
      message.folderPath,
      'Select Repository Directory',
    );
    if (!workspaceRoot) {
      void vscode.window.showWarningMessage(
        'Master orchestrator requires a repository directory to work in.',
      );
      return;
    }

    const runId = this.missionControlStore.startOrchestratorRun(
      operatorPrompt,
      (message.extraConstraints ?? []).map((constraint) => constraint.trim()).filter(Boolean),
    );

    try {
      this.missionControlStore.recordOrchestratorProgress(runId, {
        message: 'Resolving repository root and active branch.',
        phaseLabel: 'Preparing Repository',
        phaseDetail: 'Collecting repository context before planning the split.',
      });
      const { repoRoot, baseBranch } =
        await this.worktreeManager.getRepositoryContext(workspaceRoot);

      this.missionControlStore.recordOrchestratorProgress(runId, {
        message: `Repository ready on branch ${baseBranch}. Checking tracked working tree state.`,
        phaseLabel: 'Preparing Repository',
        phaseDetail:
          'Checking that the tracked working tree is clean before creating isolated worktrees.',
      });
      await this.worktreeManager.assertCleanTrackedTree(repoRoot);

      const plan = await this.masterOrchestrator.planWork({
        repoRoot,
        baseBranch,
        userPrompt: operatorPrompt,
        extraConstraints: message.extraConstraints,
        onProgress: (update) => {
          this.missionControlStore.recordOrchestratorProgress(runId, {
            message: update.message,
            level: update.level,
            phaseLabel: update.phaseLabel,
            phaseDetail: update.phaseDetail,
          });
        },
      });
      this.missionControlStore.recordOrchestratorPlan(
        runId,
        plan.planSummary,
        plan.sharedConstraints,
        plan.assignments,
      );

      const provisioned = await this.worktreeManager.provision({
        repoRoot,
        runId,
        slots: plan.assignments.map((assignment) => ({ slot: assignment.slot })),
        onStatus: async (update) => {
          this.missionControlStore.recordOrchestratorProgress(runId, {
            message:
              update.status === 'provisioning'
                ? `Provisioning isolated workspace for worker ${update.slot.toString()}.`
                : `Workspace ready for worker ${update.slot.toString()}.`,
            level: update.status === 'ready' ? 'success' : 'info',
            status: 'provisioning',
            phaseLabel: 'Provisioning Workspaces',
            phaseDetail:
              update.status === 'provisioning'
                ? `Creating worktree and branch for worker ${update.slot.toString()}.`
                : `Worker ${update.slot.toString()} workspace is ready for dispatch.`,
          });
          this.missionControlStore.upsertWorkspaceAssignment({
            repoRoot: update.repoRoot,
            branchName: update.branchName,
            worktreePath: update.worktreePath,
            status: update.status,
            orchestrationRunId: runId,
            slot: update.slot,
          });
        },
      });

      this.missionControlStore.recordOrchestratorDispatching(runId);

      for (const assignment of plan.assignments) {
        const worktree = provisioned.find((candidate) => candidate.slot === assignment.slot);
        if (!worktree) {
          throw new Error(`Missing worktree allocation for worker slot ${assignment.slot}.`);
        }

        this.missionControlStore.recordOrchestratorProgress(runId, {
          message: `Launching worker ${assignment.slot.toString()} with assignment "${assignment.title}".`,
          level: 'info',
          status: 'dispatching',
          phaseLabel: 'Launching Workers',
          phaseDetail: `Dispatching worker ${assignment.slot.toString()} into its isolated worktree.`,
        });

        const workspaceAssignment = this.missionControlStore.upsertWorkspaceAssignment({
          repoRoot: worktree.repoRoot,
          branchName: worktree.branchName,
          worktreePath: worktree.worktreePath,
          status: 'ready',
          orchestrationRunId: runId,
          slot: assignment.slot,
        });

        const workerPrompt = this.buildWorkerInitialPrompt(
          operatorPrompt,
          plan.planSummary,
          assignment,
          worktree.worktreePath,
          worktree.branchName,
          plan.sharedConstraints,
        );
        const task = {
          title: assignment.title,
          goal: assignment.goal,
          priority: 'high' as const,
          acceptanceCriteria: assignment.acceptanceCriteria,
          constraints: [
            ...plan.sharedConstraints,
            ...assignment.coordinationNotes,
            `Only edit owned repo paths: ${assignment.ownedPaths.join(', ')}`,
          ],
          expectedArtifacts: assignment.ownedPaths,
        };

        const created = await this.createAgentSession({
          folderPath: worktree.worktreePath,
          displayName: `Worker ${assignment.slot}`,
          folderName: `W${assignment.slot}`,
          initialPrompt: workerPrompt,
          orchestrationRunId: runId,
          workspaceAssignmentId: workspaceAssignment.id,
          taskInput: task,
          taskOptions: {
            createdBy: 'master',
            orchestrationRunId: runId,
            ownedPaths: assignment.ownedPaths,
          },
        });

        if (!created.agent || !created.task) {
          throw new Error(`Failed to create worker session for slot ${assignment.slot}.`);
        }

        this.missionControlStore.recordOrchestratorAssignmentLaunch(runId, assignment.slot, {
          agentId: created.agent.id,
          taskId: created.task.id,
          workspaceAssignmentId: workspaceAssignment.id,
        });
      }
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : 'Master orchestrator failed unexpectedly.';
      this.missionControlStore.recordOrchestratorFailure(runId, reason);
      void vscode.window.showErrorMessage(`Master orchestrator: ${reason}`);
    }
  }

  private getMasterAssignmentContext(slot: number):
    | {
        runId?: string;
        assignment: ReturnType<
          MissionControlStore['getSnapshot']
        >['orchestrator']['assignments'][number];
        workspace: ReturnType<MissionControlStore['getSnapshot']>['workspaces'][number];
      }
    | undefined {
    const snapshot = this.missionControlStore.getSnapshot();
    const assignment = snapshot.orchestrator.assignments.find(
      (candidate) => candidate.slot === slot,
    );
    if (!assignment?.workspaceAssignmentId) {
      return undefined;
    }
    const workspace = snapshot.workspaces.find(
      (candidate) => candidate.id === assignment.workspaceAssignmentId,
    );
    if (!workspace) {
      return undefined;
    }
    return {
      runId: snapshot.orchestrator.activeRunId,
      assignment,
      workspace,
    };
  }

  private getMasterAssignmentsWithWorkspace(): Array<{
    runId?: string;
    assignment: ReturnType<
      MissionControlStore['getSnapshot']
    >['orchestrator']['assignments'][number];
    workspace: ReturnType<MissionControlStore['getSnapshot']>['workspaces'][number];
  }> {
    const snapshot = this.missionControlStore.getSnapshot();
    const workspacesById = new Map(
      snapshot.workspaces.map((workspace) => [workspace.id, workspace] as const),
    );
    return snapshot.orchestrator.assignments
      .map((assignment) => {
        if (!assignment.workspaceAssignmentId) {
          return undefined;
        }
        const workspace = workspacesById.get(assignment.workspaceAssignmentId);
        if (!workspace) {
          return undefined;
        }
        return {
          runId: snapshot.orchestrator.activeRunId,
          assignment,
          workspace,
        };
      })
      .filter((value): value is NonNullable<typeof value> => !!value);
  }

  private postMasterWorkerReview(
    slot: number,
    review: WorktreeReview,
    context: {
      branchName?: string;
      repoRoot: string;
      worktreePath: string;
      title: string;
    },
  ): void {
    this.webview?.postMessage({
      type: 'masterWorkerReviewLoaded',
      slot,
      review: {
        ...review,
        branchName: context.branchName,
        repoRoot: context.repoRoot,
        worktreePath: context.worktreePath,
        title: context.title,
      },
    });
  }

  private async loadMasterWorkerReview(slot: number): Promise<void> {
    const context = this.getMasterAssignmentContext(slot);
    if (!context) {
      this.webview?.postMessage({
        type: 'masterWorkerReviewFailed',
        slot,
        error: `Worker ${slot.toString()} is missing its workspace assignment.`,
      });
      return;
    }

    try {
      const review = await this.worktreeManager.getWorktreeReview({
        repoRoot: context.workspace.repoRoot,
        worktreePath: context.workspace.worktreePath,
        ownedPaths: context.assignment.ownedPaths,
      });
      if (review.hasChanges) {
        this.missionControlStore.upsertWorkspaceAssignment({
          repoRoot: context.workspace.repoRoot,
          branchName: context.workspace.branchName,
          worktreePath: context.workspace.worktreePath,
          status: 'merge_pending',
          assignedSessionId: context.workspace.assignedSessionId,
          orchestrationRunId: context.workspace.orchestrationRunId,
          slot: context.workspace.slot,
        });
      }
      this.postMasterWorkerReview(slot, review, {
        branchName: context.workspace.branchName,
        repoRoot: context.workspace.repoRoot,
        worktreePath: context.workspace.worktreePath,
        title: context.assignment.title,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Failed to load worker review.';
      this.webview?.postMessage({
        type: 'masterWorkerReviewFailed',
        slot,
        error: reason,
      });
    }
  }

  private async applyMasterWorkerChanges(slot: number): Promise<void> {
    const context = this.getMasterAssignmentContext(slot);
    if (!context) {
      this.webview?.postMessage({
        type: 'masterWorkerReviewApplyFailed',
        slot,
        error: `Worker ${slot.toString()} is missing its workspace assignment.`,
      });
      return;
    }

    try {
      const result = await this.worktreeManager.applyWorktreeChanges({
        repoRoot: context.workspace.repoRoot,
        worktreePath: context.workspace.worktreePath,
        ownedPaths: context.assignment.ownedPaths,
      });
      this.missionControlStore.upsertWorkspaceAssignment({
        repoRoot: context.workspace.repoRoot,
        branchName: context.workspace.branchName,
        worktreePath: context.workspace.worktreePath,
        status: result.hasChanges ? 'merged' : 'ready',
        assignedSessionId: context.workspace.assignedSessionId,
        orchestrationRunId: context.workspace.orchestrationRunId,
        slot: context.workspace.slot,
      });

      if (context.runId && result.hasChanges) {
        this.missionControlStore.recordOrchestratorProgress(context.runId, {
          message: `Approved worker ${slot.toString()} changes and applied them to the main checkout.`,
          level: 'success',
          phaseLabel: 'Review Applied',
          phaseDetail: `Worker ${slot.toString()} changes now exist in ${context.workspace.repoRoot}.`,
          status: 'completed',
        });
      }

      this.webview?.postMessage({
        type: 'masterWorkerReviewApplied',
        slot,
        result,
      });
      void vscode.window.showInformationMessage(
        result.hasChanges
          ? `Worker ${slot.toString()} changes were applied to the main checkout.`
          : `Worker ${slot.toString()} has no pending changes to apply.`,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Failed to apply worker changes.';
      this.webview?.postMessage({
        type: 'masterWorkerReviewApplyFailed',
        slot,
        error: reason,
      });
      void vscode.window.showErrorMessage(`Master orchestrator: ${reason}`);
    }
  }

  private async loadMasterTeamReview(): Promise<void> {
    const contexts = this.getMasterAssignmentsWithWorkspace();
    if (contexts.length === 0) {
      this.webview?.postMessage({
        type: 'masterTeamReviewFailed',
        error: 'No worker workspaces are available for review yet.',
      });
      return;
    }

    try {
      const workers = await Promise.all(
        contexts.map(async (context) => {
          const review = await this.worktreeManager.getWorktreeReview({
            repoRoot: context.workspace.repoRoot,
            worktreePath: context.workspace.worktreePath,
            ownedPaths: context.assignment.ownedPaths,
          });
          if (review.hasChanges) {
            this.missionControlStore.upsertWorkspaceAssignment({
              repoRoot: context.workspace.repoRoot,
              branchName: context.workspace.branchName,
              worktreePath: context.workspace.worktreePath,
              status: 'merge_pending',
              assignedSessionId: context.workspace.assignedSessionId,
              orchestrationRunId: context.workspace.orchestrationRunId,
              slot: context.workspace.slot,
            });
          }
          return {
            slot: context.assignment.slot,
            title: context.assignment.title,
            branchName: context.workspace.branchName,
            repoRoot: context.workspace.repoRoot,
            worktreePath: context.workspace.worktreePath,
            ownedPaths: review.ownedPaths,
            changedFiles: review.changedFiles,
            diff: review.diff,
            diffTruncated: review.diffTruncated,
            hasChanges: review.hasChanges,
          };
        }),
      );

      this.webview?.postMessage({
        type: 'masterTeamReviewLoaded',
        review: {
          runId: this.missionControlStore.getSnapshot().orchestrator.activeRunId,
          workers,
        },
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Failed to load team review.';
      this.webview?.postMessage({
        type: 'masterTeamReviewFailed',
        error: reason,
      });
    }
  }

  private async applyMasterTeamReview(): Promise<void> {
    const contexts = this.getMasterAssignmentsWithWorkspace();
    if (contexts.length === 0) {
      this.webview?.postMessage({
        type: 'masterTeamReviewApplyFailed',
        error: 'No worker workspaces are available to apply.',
      });
      return;
    }

    try {
      const workers = [];
      let totalAppliedFiles = 0;
      let totalRemovedFiles = 0;

      for (const context of contexts) {
        const result = await this.worktreeManager.applyWorktreeChanges({
          repoRoot: context.workspace.repoRoot,
          worktreePath: context.workspace.worktreePath,
          ownedPaths: context.assignment.ownedPaths,
        });
        this.missionControlStore.upsertWorkspaceAssignment({
          repoRoot: context.workspace.repoRoot,
          branchName: context.workspace.branchName,
          worktreePath: context.workspace.worktreePath,
          status: result.hasChanges ? 'merged' : context.workspace.status,
          assignedSessionId: context.workspace.assignedSessionId,
          orchestrationRunId: context.workspace.orchestrationRunId,
          slot: context.workspace.slot,
        });
        totalAppliedFiles += result.appliedFiles.length;
        totalRemovedFiles += result.removedFiles.length;
        workers.push({
          slot: context.assignment.slot,
          title: context.assignment.title,
          appliedFiles: result.appliedFiles,
          removedFiles: result.removedFiles,
          hasChanges: result.hasChanges,
        });
      }

      const runId = this.missionControlStore.getSnapshot().orchestrator.activeRunId;
      if (runId) {
        this.missionControlStore.recordOrchestratorProgress(runId, {
          message: `Approved the full team review and applied ${totalAppliedFiles.toString()} file(s) with ${totalRemovedFiles.toString()} removals to the main checkout.`,
          level: 'success',
          phaseLabel: 'Review Applied',
          phaseDetail:
            'All approved worker changes now exist in the main checkout and are ready for commit.',
          status: 'completed',
        });
      }

      this.webview?.postMessage({
        type: 'masterTeamReviewApplied',
        result: {
          workers,
          totalAppliedFiles,
          totalRemovedFiles,
        },
      });
      void vscode.window.showInformationMessage(
        `Approved team review. Applied ${totalAppliedFiles.toString()} file(s) with ${totalRemovedFiles.toString()} removals to the main checkout.`,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Failed to apply team review.';
      this.webview?.postMessage({
        type: 'masterTeamReviewApplyFailed',
        error: reason,
      });
      void vscode.window.showErrorMessage(`Master orchestrator: ${reason}`);
    }
  }

  private async interruptAgent(agentId: number): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      void vscode.window.showWarningMessage(
        'Mission Control: This session cannot be interrupted from the extension.',
      );
      return;
    }

    if (this.hasManagedTerminalSession(agentId)) {
      this.interruptManagedTerminal(agentId);
    } else if (agent.terminalRef) {
      agent.terminalRef.show();
      await vscode.commands.executeCommand('workbench.action.terminal.sendSequence', {
        text: '\u0003',
      });
    } else {
      void vscode.window.showWarningMessage(
        'Mission Control: This session cannot be interrupted from the extension.',
      );
      return;
    }

    this.missionControlStore.recordInterrupt(agent);
  }

  private initHooks(): void {
    this.hookEventHandler = new HookEventHandler(
      this.agents,
      this.waitingTimers,
      this.permissionTimers,
      () => this.webview,
      this.watchAllSessions,
    );

    this.hookEventHandler.setLifecycleCallbacks({
      onExternalSessionDetected: (_sessionId, _transcriptPath, _cwd) => {
        // Adopt logic without file scanning
      },
      onSessionClear: (agentId, newSessionId, _newTranscriptPath) => {
        const agent = this.agents.get(agentId);
        if (agent) {
          this.unregisterAgentHook(agent);
          agent.sessionId = newSessionId;
          this.registerAgentHook(agent);
        }
      },
      onSessionResume: (_transcriptPath) => {},
      onSessionEnd: (agentId) => {
        const agent = this.agents.get(agentId);
        if (!agent) return;
        if (agent.isExternal) {
          this.removeManagedAgent(agentId, 'External session ended');
        }
      },
      onHookEvent: (agentId, providerId, event, agent) => {
        const trackedAgent = this.agents.get(agentId) ?? agent;
        this.missionControlStore.handleHookEvent(trackedAgent, providerId, event);
      },
    });

    this.pixelAgentsServer = new PixelAgentsServer();
    this.pixelAgentsServer.onHookEvent((providerId, event) => {
      this.hookEventHandler?.handleEvent(providerId, event as HookEvent);
    });

    this.pixelAgentsServer
      .start()
      .then((config) => {
        const hooksEnabled = this.context.globalState.get<boolean>(GLOBAL_KEY_HOOKS_ENABLED, true);
        this.hooksEnabled.current = hooksEnabled;
        if (hooksEnabled) {
          installHooks();
          copyHookScript(this.context.extensionPath);
        }
        console.log(`[Pixel Agents] Server: ready on port ${config.port}`);
      })
      .catch((e) => {
        console.error(`[Pixel Agents] Failed to start server: ${e}`);
      });
  }

  registerAgentHook(agent: AgentState): void {
    if (!agent.sessionId) return;
    this.hookEventHandler?.registerAgent(agent.sessionId, agent.id);
  }

  unregisterAgentHook(agent: AgentState): void {
    if (!agent.sessionId) return;
    this.hookEventHandler?.unregisterAgent(agent.sessionId);
  }

  async toggleVoiceDictation(): Promise<void> {
    if (await this.voiceDictationManager.toggle()) {
      return;
    }

    if (this.webviewReady) {
      this.webview?.postMessage({ type: 'toggleVoiceDictation' });
      return;
    }

    this.pendingVoiceDictationToggle = true;
    await vscode.commands.executeCommand(COMMAND_SHOW_PANEL);
  }

  private async insertVoiceDictationText(text: string): Promise<void> {
    if (!text) {
      return;
    }

    try {
      await vscode.commands.executeCommand('type', { text });
    } catch (err) {
      console.error('[Pixel Agents] Voice dictation insert failed:', err);
      void vscode.window.showWarningMessage(
        'Pixel Agents: Could not insert dictated text into the current VS Code input.',
      );
    }
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.webviewView = webviewView;
    this.webviewReady = false;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = getWebviewContent(webviewView.webview, this.extensionUri);

    webviewView.webview.onDidReceiveMessage(async (message) => {
      if (message.type === 'openCodex') {
        const folderPath = await this.resolveWorkingDirectory(
          message.folderPath as string | undefined,
          'Select Working Directory',
        );
        if (!folderPath) {
          return;
        }
        await this.createAgentSession({
          folderPath,
          bypassPermissions: message.bypassPermissions as boolean | undefined,
        });
      } else if (message.type === 'startMasterOrchestration') {
        await this.startMasterOrchestration({
          prompt: message.prompt as string,
          extraConstraints: (message.extraConstraints as string[] | undefined) ?? [],
          folderPath: message.folderPath as string | undefined,
        });
      } else if (message.type === 'resetMasterOrchestrator') {
        this.missionControlStore.resetOrchestrator(
          'Master orchestrator was reset by the operator.',
        );
      } else if (message.type === 'loadMasterWorkerReview') {
        await this.loadMasterWorkerReview(message.slot as number);
      } else if (message.type === 'applyMasterWorkerChanges') {
        await this.applyMasterWorkerChanges(message.slot as number);
      } else if (message.type === 'loadMasterTeamReview') {
        await this.loadMasterTeamReview();
      } else if (message.type === 'applyMasterTeamReview') {
        await this.applyMasterTeamReview();
      } else if (message.type === 'terminalInput') {
        this.sendManagedTerminalInput(message.agentId as number, message.data as string);
      } else if (message.type === 'terminalResize') {
        const snapshot = this.resizeManagedTerminal(
          message.agentId as number,
          message.cols as number,
          message.rows as number,
        );
        if (snapshot) {
          this.postTerminalSnapshot(message.agentId as number, snapshot);
        }
      } else if (message.type === 'interruptAgent') {
        await this.interruptAgent(message.id as number);
      } else if (message.type === 'createMissionTask') {
        this.missionControlStore.createTask({
          title: message.title as string | undefined,
          goal: message.goal as string,
          priority: message.priority as MissionControlTask['priority'] | undefined,
          acceptanceCriteria: (message.acceptanceCriteria as string[] | undefined) ?? [],
          constraints: (message.constraints as string[] | undefined) ?? [],
          expectedArtifacts: (message.expectedArtifacts as string[] | undefined) ?? [],
        });
      } else if (message.type === 'submitMissionTask') {
        const agent = this.agents.get(message.agentId as number);
        if (!agent) {
          void vscode.window.showWarningMessage('Mission Control: Agent not found.');
          return;
        }
        if (agent.isExternal) {
          void vscode.window.showWarningMessage(
            'Mission Control: External sessions can be inspected but not dispatched from this window.',
          );
          return;
        }
        const task = this.missionControlStore.submitTask(
          {
            title: message.title as string | undefined,
            goal: message.goal as string,
            priority: message.priority as MissionControlTask['priority'] | undefined,
            acceptanceCriteria: (message.acceptanceCriteria as string[] | undefined) ?? [],
            constraints: (message.constraints as string[] | undefined) ?? [],
            expectedArtifacts: (message.expectedArtifacts as string[] | undefined) ?? [],
          },
          agent,
        );
        if (!task) {
          void vscode.window.showWarningMessage('Mission Control: Failed to create task.');
          return;
        }
        const prompt = this.buildTaskDispatchPrompt(task);
        if (!this.sendManagedTerminalLine(agent.id, prompt) && agent.terminalRef) {
          agent.terminalRef.sendText(prompt, true);
        }
      } else if (message.type === 'assignMissionTask') {
        const agent = this.agents.get(message.agentId as number);
        if (!agent) {
          void vscode.window.showWarningMessage('Mission Control: Agent not found.');
          return;
        }
        if (agent.isExternal) {
          void vscode.window.showWarningMessage(
            'Mission Control: External sessions can be inspected but not dispatched from this window.',
          );
          return;
        }
        const task = this.missionControlStore.assignTask(message.taskId as string, agent);
        if (!task) {
          void vscode.window.showWarningMessage('Mission Control: Task not found.');
          return;
        }
        const prompt = this.buildTaskDispatchPrompt(task);
        if (!this.sendManagedTerminalLine(agent.id, prompt) && agent.terminalRef) {
          agent.terminalRef.sendText(prompt, true);
        }
      } else if (message.type === 'updateMissionTaskStatus') {
        this.missionControlStore.updateTaskStatus(
          message.taskId as string,
          message.status as MissionControlTask['status'],
          message.latestUpdate as string | undefined,
        );
      } else if (message.type === 'resolveApprovalRequest') {
        this.missionControlStore.resolveApproval(
          message.approvalId as string,
          message.status as 'approved' | 'rejected',
          message.decisionSummary as string | undefined,
        );
      } else if (message.type === 'closeAgent') {
        const agent = this.agents.get(message.id);
        if (agent) {
          if (this.hasManagedTerminalSession(agent.id)) {
            this.removeManagedAgent(message.id, 'Agent closed from Mission Control');
          } else if (agent.terminalRef) {
            this.removeManagedAgent(message.id, 'Agent closed from Mission Control', {
              disposeTerminal: true,
            });
          } else {
            this.removeManagedAgent(message.id, 'Agent closed from Mission Control');
          }
        }
      } else if (message.type === 'saveAgentSeats') {
        console.log(`[Pixel Agents] State: saveAgentSeats:`, JSON.stringify(message.seats));
        safeUpdateState(this.context.workspaceState, WORKSPACE_KEY_AGENT_SEATS, message.seats);
      } else if (message.type === 'saveLayout') {
        this.layoutWatcher?.markOwnWrite();
        writeLayoutToFile(message.layout as Record<string, unknown>);
      } else if (message.type === 'setSoundEnabled') {
        safeUpdateState(this.context.globalState, GLOBAL_KEY_SOUND_ENABLED, message.enabled);
      } else if (message.type === 'setLastSeenVersion') {
        safeUpdateState(
          this.context.globalState,
          GLOBAL_KEY_LAST_SEEN_VERSION,
          message.version as string,
        );
      } else if (message.type === 'setAlwaysShowLabels') {
        safeUpdateState(this.context.globalState, GLOBAL_KEY_ALWAYS_SHOW_LABELS, message.enabled);
      } else if (message.type === 'setHooksEnabled') {
        const enabled = message.enabled as boolean;
        safeUpdateState(this.context.globalState, GLOBAL_KEY_HOOKS_ENABLED, enabled);
        this.hooksEnabled.current = enabled;
        if (enabled) {
          installHooks();
          copyHookScript(this.context.extensionPath);
          console.log('[Pixel Agents] Hooks enabled by user');
        } else {
          uninstallHooks();
          console.log('[Pixel Agents] Hooks disabled by user');
        }
      } else if (message.type === 'setHooksInfoShown') {
        safeUpdateState(this.context.globalState, GLOBAL_KEY_HOOKS_INFO_SHOWN, true);
      } else if (message.type === 'setWatchAllSessions') {
        const enabled = message.enabled as boolean;
        safeUpdateState(this.context.globalState, GLOBAL_KEY_WATCH_ALL_SESSIONS, enabled);
        this.watchAllSessions.current = enabled;
        if (!enabled) {
          const workspaceDirs = new Set<string>();
          for (const directory of this.getKnownWorkingDirectories()) {
            const dir = getProjectDirPath(directory);
            if (dir) workspaceDirs.add(dir);
          }
          const toRemove: number[] = [];
          for (const [id, agent] of this.agents) {
            if (agent.isExternal && !workspaceDirs.has(agent.projectDir)) {
              toRemove.push(id);
            }
          }
          for (const id of toRemove) {
            const agent = this.agents.get(id);
            if (agent) {
              this.missionControlStore.recordAgentRemoved(
                agent,
                'Removed after Watch All Sessions was disabled',
              );
            }
            removeAgent(
              id,
              this.agents,
              this.waitingTimers,
              this.permissionTimers,
              this.persistAgents,
            );
            this.webview?.postMessage({ type: 'agentClosed', id });
          }
        }
      } else if (message.type === 'webviewReady') {
        this.webviewReady = true;
        restoreAgents(
          this.context,
          this.nextAgentId,
          this.nextTerminalIndex,
          this.agents,
          this.persistAgents,
        );
        this.missionControlStore.hydrate(this.agents.values());
        for (const agent of this.agents.values()) {
          this.registerAgentHook(agent);
        }
        this.missionControlStore.syncAgents(this.agents.values());
        const soundEnabled = this.context.globalState.get<boolean>(GLOBAL_KEY_SOUND_ENABLED, true);
        const lastSeenVersion = this.context.globalState.get<string>(
          GLOBAL_KEY_LAST_SEEN_VERSION,
          '',
        );
        const extensionVersion =
          (this.context.extension.packageJSON as { version?: string }).version ?? '';
        const watchAllSessions = this.context.globalState.get<boolean>(
          GLOBAL_KEY_WATCH_ALL_SESSIONS,
          false,
        );
        const alwaysShowLabels = this.context.globalState.get<boolean>(
          GLOBAL_KEY_ALWAYS_SHOW_LABELS,
          false,
        );
        this.watchAllSessions.current = watchAllSessions;
        const hooksEnabled = this.context.globalState.get<boolean>(GLOBAL_KEY_HOOKS_ENABLED, true);
        const hooksInfoShown = this.context.globalState.get<boolean>(
          GLOBAL_KEY_HOOKS_INFO_SHOWN,
          false,
        );
        const config = readConfig();
        this.webview?.postMessage({
          type: 'settingsLoaded',
          soundEnabled,
          lastSeenVersion,
          extensionVersion,
          watchAllSessions,
          alwaysShowLabels,
          hooksEnabled,
          hooksInfoShown,
          externalAssetDirectories: config.externalAssetDirectories,
          projectDirectories: config.projectDirectories,
        });

        const wsFolders = vscode.workspace.workspaceFolders;
        this.webview?.postMessage({
          type: 'workspaceFolders',
          folders: (wsFolders ?? []).map((f) => ({ name: f.name, path: f.uri.fsPath })),
        });

        (async () => {
          try {
            console.log('[Extension] Loading furniture assets...');
            const extensionPath = this.extensionUri.fsPath;

            const bundledAssetsDir = path.join(extensionPath, 'dist', 'assets');
            let assetsRoot: string | null = null;
            if (fs.existsSync(bundledAssetsDir)) {
              assetsRoot = path.join(extensionPath, 'dist');
            } else if (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath) {
              assetsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            }

            if (!assetsRoot) {
              if (this.webview) {
                sendLayout(this.context, this.webview, this.defaultLayout);
                sendCurrentAgentStatuses(this.agents, this.webview);
                this.startLayoutWatcher();
              }
              return;
            }

            this.assetsRoot = assetsRoot;
            this.defaultLayout = loadDefaultLayout(assetsRoot);

            const charSprites = await this.loadAllCharacterSprites();
            if (charSprites && this.webview) {
              sendCharacterSpritesToWebview(this.webview, charSprites);
            }

            const floorTiles = await loadFloorTiles(assetsRoot);
            if (floorTiles && this.webview) {
              sendFloorTilesToWebview(this.webview, floorTiles);
            }

            const wallTiles = await loadWallTiles(assetsRoot);
            if (wallTiles && this.webview) {
              sendWallTilesToWebview(this.webview, wallTiles);
            }

            const assets = await this.loadAllFurnitureAssets();
            if (assets && this.webview) {
              sendAssetsToWebview(this.webview, assets);
            }
          } catch (err) {
            console.error('[Extension] ❌ Error loading assets:', err);
          }
          if (this.webview) {
            sendLayout(this.context, this.webview, this.defaultLayout);
            sendCurrentAgentStatuses(this.agents, this.webview);
            this.startLayoutWatcher();
          }
        })();
        sendExistingAgents(this.agents, this.context, this.webview);
        this.syncAllTerminalSnapshots();
        this.webview?.postMessage({
          type: 'missionControlSnapshot',
          snapshot: this.missionControlStore.getSnapshot(),
        });
        if (this.shouldAutoCreateNativeMasterSession()) {
          await this.createAgentSession();
        }
        if (this.pendingVoiceDictationToggle) {
          this.pendingVoiceDictationToggle = false;
          this.webview?.postMessage({ type: 'toggleVoiceDictation' });
        }
      } else if (message.type === 'voiceDictationTypeText') {
        const text = typeof message.text === 'string' ? message.text : '';
        await this.insertVoiceDictationText(text);
      } else if (message.type === 'requestDiagnostics') {
        const diagnostics: Array<Record<string, unknown>> = [];
        for (const [, agent] of this.agents) {
          diagnostics.push({
            id: agent.id,
            projectDir: agent.projectDir,
            projectDirExists: fs.existsSync(agent.projectDir),
          });
        }
        this.webview?.postMessage({ type: 'agentDiagnostics', agents: diagnostics });
      } else if (message.type === 'openSessionsFolder') {
        const projectDir = getProjectDirPath();
        if (projectDir && fs.existsSync(projectDir)) {
          vscode.env.openExternal(vscode.Uri.file(projectDir));
        }
      } else if (message.type === 'exportLayout') {
        const layout = readLayoutFromFile();
        if (!layout) {
          vscode.window.showWarningMessage('Pixel Agents: No saved layout to export.');
          return;
        }
        const uri = await vscode.window.showSaveDialog({
          filters: { 'JSON Files': ['json'] },
          defaultUri: vscode.Uri.file(path.join(os.homedir(), 'pixel-agents-layout.json')),
        });
        if (uri) {
          fs.writeFileSync(uri.fsPath, JSON.stringify(layout, null, 2), 'utf-8');
          vscode.window.showInformationMessage('Pixel Agents: Layout exported successfully.');
        }
      } else if (message.type === 'addExternalAssetDirectory') {
        const uris = await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectFiles: false,
          canSelectMany: false,
          openLabel: 'Select Asset Directory',
        });
        if (!uris || uris.length === 0) return;
        const newPath = uris[0].fsPath;
        const cfg = readConfig();
        if (!cfg.externalAssetDirectories.includes(newPath)) {
          cfg.externalAssetDirectories.push(newPath);
          writeConfig(cfg);
        }
        await this.reloadAndSendCharacters();
        await this.reloadAndSendFurniture();
        this.webview?.postMessage({
          type: 'externalAssetDirectoriesUpdated',
          dirs: cfg.externalAssetDirectories,
        });
      } else if (message.type === 'addProjectDirectory') {
        const uris = await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectFiles: false,
          canSelectMany: false,
          openLabel: 'Select Project Directory',
        });
        if (!uris || uris.length === 0) return;
        const newPath = uris[0].fsPath;
        const cfg = readConfig();
        if (!cfg.projectDirectories.includes(newPath)) {
          cfg.projectDirectories.push(newPath);
          writeConfig(cfg);
        }
        this.postProjectDirectoriesUpdated();
      } else if (message.type === 'removeProjectDirectory') {
        const cfg = readConfig();
        cfg.projectDirectories = cfg.projectDirectories.filter(
          (d) => d !== (message.path as string),
        );
        writeConfig(cfg);
        this.postProjectDirectoriesUpdated();
      } else if (message.type === 'removeExternalAssetDirectory') {
        const cfg = readConfig();
        cfg.externalAssetDirectories = cfg.externalAssetDirectories.filter(
          (d) => d !== (message.path as string),
        );
        writeConfig(cfg);
        await this.reloadAndSendCharacters();
        await this.reloadAndSendFurniture();
        this.webview?.postMessage({
          type: 'externalAssetDirectoriesUpdated',
          dirs: cfg.externalAssetDirectories,
        });
      } else if (message.type === 'importLayout') {
        const uris = await vscode.window.showOpenDialog({
          filters: { 'JSON Files': ['json'] },
          canSelectMany: false,
        });
        if (!uris || uris.length === 0) return;
        try {
          const raw = fs.readFileSync(uris[0].fsPath, 'utf-8');
          const imported = JSON.parse(raw) as Record<string, unknown>;
          if (imported.version !== 1 || !Array.isArray(imported.tiles)) {
            vscode.window.showErrorMessage('Pixel Agents: Invalid layout file.');
            return;
          }
          this.layoutWatcher?.markOwnWrite();
          writeLayoutToFile(imported);
          this.webview?.postMessage({ type: 'layoutLoaded', layout: imported });
          vscode.window.showInformationMessage('Pixel Agents: Layout imported successfully.');
        } catch {
          vscode.window.showErrorMessage('Pixel Agents: Failed to read or parse layout file.');
        }
      }
    });

    vscode.window.onDidChangeActiveTerminal((terminal) => {
      this.activeAgentId.current = null;
      if (!terminal) return;
      for (const [id, agent] of this.agents) {
        if (agent.terminalRef && agent.terminalRef === terminal) {
          this.activeAgentId.current = id;
          webviewView.webview.postMessage({ type: 'agentSelected', id });
          break;
        }
      }
    });

    vscode.window.onDidCloseTerminal((closed) => {
      for (const [id, agent] of this.agents) {
        if (agent.terminalRef && agent.terminalRef === closed) {
          if (this.activeAgentId.current === id) {
            this.activeAgentId.current = null;
          }
          this.removeManagedAgent(id, 'Terminal closed');
        }
      }
    });
  }

  exportDefaultLayout(): void {
    const layout = readLayoutFromFile();
    if (!layout) {
      vscode.window.showWarningMessage('Pixel Agents: No saved layout found.');
      return;
    }
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      vscode.window.showErrorMessage('Pixel Agents: No workspace folder found.');
      return;
    }
    const assetsDir = path.join(workspaceRoot, 'webview-ui', 'public', 'assets');

    let maxRevision = 0;
    if (fs.existsSync(assetsDir)) {
      for (const file of fs.readdirSync(assetsDir)) {
        const match = /^default-layout-(\d+)\.json$/.exec(file);
        if (match) {
          maxRevision = Math.max(maxRevision, parseInt(match[1], 10));
        }
      }
    }
    const nextRevision = maxRevision + 1;
    layout[LAYOUT_REVISION_KEY] = nextRevision;

    const targetPath = path.join(assetsDir, `default-layout-${nextRevision}.json`);
    const json = JSON.stringify(layout, null, 2);
    fs.writeFileSync(targetPath, json, 'utf-8');
    vscode.window.showInformationMessage(
      `Pixel Agents: Default layout exported as revision ${nextRevision} to ${targetPath}`,
    );
  }

  private async loadAllFurnitureAssets(): Promise<LoadedAssets | null> {
    if (!this.assetsRoot) return null;
    let assets = await loadFurnitureAssets(this.assetsRoot);
    const config = readConfig();
    for (const extraDir of config.externalAssetDirectories) {
      console.log('[Extension] Loading external assets from:', extraDir);
      const extra = await loadFurnitureAssets(extraDir);
      if (extra) {
        assets = assets ? mergeLoadedAssets(assets, extra) : extra;
      }
    }
    return assets;
  }

  private async loadAllCharacterSprites(): Promise<LoadedCharacterSprites | null> {
    if (!this.assetsRoot) return null;
    let chars = await loadCharacterSprites(this.assetsRoot);
    const config = readConfig();
    for (const extraDir of config.externalAssetDirectories) {
      console.log('[Extension] Loading external character sprites from:', extraDir);
      const extra = await loadExternalCharacterSprites(extraDir);
      if (extra) {
        chars = chars ? mergeCharacterSprites(chars, extra) : extra;
      }
    }
    return chars;
  }

  private async reloadAndSendFurniture(): Promise<void> {
    if (!this.assetsRoot || !this.webview) return;
    try {
      const assets = await this.loadAllFurnitureAssets();
      if (assets) {
        sendAssetsToWebview(this.webview, assets);
      }
    } catch (err) {
      console.error('[Extension] Error reloading furniture assets:', err);
    }
  }

  private async reloadAndSendCharacters(): Promise<void> {
    if (!this.assetsRoot || !this.webview) return;
    try {
      const chars = await this.loadAllCharacterSprites();
      if (chars) {
        sendCharacterSpritesToWebview(this.webview, chars);
      }
    } catch (err) {
      console.error('[Extension] Error reloading character sprites:', err);
    }
  }

  private startLayoutWatcher(): void {
    if (this.layoutWatcher) return;
    this.layoutWatcher = watchLayoutFile((layout) => {
      console.log('[Pixel Agents] External layout change — pushing to webview');
      this.webview?.postMessage({ type: 'layoutLoaded', layout });
    });
  }

  dispose() {
    this.missionControlUnsubscribe?.();
    this.missionControlUnsubscribe = null;
    this.voiceDictationManager.dispose();
    this.embeddedTerminalManager.disposeAll();
    this.nativeTerminalManager.dispose();
    this.missionControlStore.dispose();
    this.pixelAgentsServer?.stop();
    this.pixelAgentsServer = null;
    this.hookEventHandler?.dispose();
    this.hookEventHandler = null;
    this.layoutWatcher?.dispose();
    this.layoutWatcher = null;
    for (const id of [...this.agents.keys()]) {
      removeAgent(id, this.agents, this.waitingTimers, this.permissionTimers, this.persistAgents);
    }
  }
}

function getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const distPath = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
  const indexPath = vscode.Uri.joinPath(distPath, 'index.html').fsPath;

  let html = fs.readFileSync(indexPath, 'utf-8');

  html = html.replace(/(href|src)="\.\/([^"]+)"/g, (_match, attr, filePath) => {
    const fileUri = vscode.Uri.joinPath(distPath, filePath);
    const webviewUri = webview.asWebviewUri(fileUri);
    return `${attr}="${webviewUri}"`;
  });

  return html;
}
