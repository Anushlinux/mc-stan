import * as vscode from 'vscode';

import type { EmbeddedTerminalSnapshot } from '../shared/embeddedTerminal.js';

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;
const MAX_BUFFER_CHARS = 200_000;
const SHELL_INTEGRATION_TIMEOUT_MS = 8_000;

interface NativeSessionState {
  terminal: vscode.Terminal;
  buffer: string;
  status: EmbeddedTerminalSnapshot['status'];
  cols: number;
  rows: number;
  expectedCommandLine: string;
  execution?: vscode.TerminalShellExecution;
  exitCode?: number;
  reason?: string;
  suppressExitCallback: boolean;
}

interface PendingExecutionStart {
  timer: ReturnType<typeof setTimeout>;
  resolve: (execution: vscode.TerminalShellExecution) => void;
  reject: (error: Error) => void;
}

interface LaunchNativeSessionOptions {
  agentId: number;
  cwd: string;
  name: string;
  command: string;
  args?: string[];
  cols?: number;
  rows?: number;
}

interface NativeTerminalManagerCallbacks {
  onData: (agentId: number, data: string) => void;
  onSnapshot: (agentId: number, snapshot: EmbeddedTerminalSnapshot) => void;
  onExit: (
    agentId: number,
    details: {
      exitCode?: number;
      reason: string;
    },
  ) => void;
}

function trimBuffer(buffer: string): { buffer: string; truncated: boolean } {
  if (buffer.length <= MAX_BUFFER_CHARS) {
    return { buffer, truncated: false };
  }

  return {
    buffer: buffer.slice(-MAX_BUFFER_CHARS),
    truncated: true,
  };
}

function buildReasonForExit(
  status: EmbeddedTerminalSnapshot['status'],
  exitCode: number | undefined,
): string {
  if (status === 'failed') {
    if (exitCode !== undefined) {
      return `Agent failed to start (exit code ${exitCode})`;
    }
    return 'Agent failed to start';
  }

  if (exitCode !== undefined && exitCode !== 0) {
    return `Session ended (exit code ${exitCode})`;
  }
  return 'Session ended';
}

function quoteCommandPart(part: string): string {
  if (!/[\s"'\\$`!]/.test(part)) {
    return part;
  }

  return `"${part.replace(/["\\$`]/g, '\\$&')}"`;
}

function buildExpectedCommandLine(command: string, args: string[]): string {
  return [command, ...args].map(quoteCommandPart).join(' ');
}

function normalizeCommandLine(commandLine: string): string {
  return commandLine.replace(/\s+/g, ' ').trim();
}

function matchesExpectedCommandLine(expected: string, actual: string): boolean {
  const normalizedExpected = normalizeCommandLine(expected);
  const normalizedActual = normalizeCommandLine(actual);

  if (!normalizedExpected || !normalizedActual) {
    return false;
  }

  if (normalizedExpected === normalizedActual) {
    return true;
  }

  const unquotedExpected = normalizedExpected.replace(/^['"]|['"]$/g, '');
  const unquotedActual = normalizedActual.replace(/^['"]|['"]$/g, '');

  return unquotedExpected === unquotedActual;
}

export class NativeTerminalManager implements vscode.Disposable {
  private liveSessions = new Map<number, NativeSessionState>();
  private snapshots = new Map<number, EmbeddedTerminalSnapshot>();
  private terminalToAgentId = new Map<vscode.Terminal, number>();
  private executionToAgentId = new Map<vscode.TerminalShellExecution, number>();
  private pendingExecutionStarts = new Map<number, PendingExecutionStart>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly callbacks: NativeTerminalManagerCallbacks) {
    this.disposables.push(
      vscode.window.onDidStartTerminalShellExecution((event) => {
        const agentId = this.terminalToAgentId.get(event.terminal);
        if (agentId === undefined) return;

        const session = this.liveSessions.get(agentId);
        if (!session) return;
        if (
          !matchesExpectedCommandLine(
            session.expectedCommandLine,
            event.execution.commandLine.value,
          )
        ) {
          return;
        }

        this.attachExecution(agentId, session, event.execution);
        this.resolvePendingExecutionStart(agentId, event.execution);
      }),
    );

    this.disposables.push(
      vscode.window.onDidEndTerminalShellExecution((event) => {
        const agentId =
          this.executionToAgentId.get(event.execution) ??
          this.terminalToAgentId.get(event.terminal);
        if (agentId === undefined) return;

        const session = this.liveSessions.get(agentId);
        if (!session || session.execution !== event.execution) {
          this.executionToAgentId.delete(event.execution);
          return;
        }

        session.status = session.status === 'starting' ? 'failed' : 'exited';
        session.exitCode = event.exitCode;
        session.reason = buildReasonForExit(session.status, event.exitCode);
        this.emitSnapshot(agentId, session);

        this.executionToAgentId.delete(event.execution);

        if (session.suppressExitCallback) {
          return;
        }

        this.callbacks.onExit(agentId, {
          exitCode: event.exitCode,
          reason: session.reason,
        });
      }),
    );
  }

  launchSession(options: LaunchNativeSessionOptions): {
    terminal: vscode.Terminal;
    snapshot: EmbeddedTerminalSnapshot;
  } {
    this.disposeSession(options.agentId);

    const cols = options.cols ?? DEFAULT_COLS;
    const rows = options.rows ?? DEFAULT_ROWS;
    const expectedCommandLine = buildExpectedCommandLine(options.command, options.args ?? []);
    const terminal = vscode.window.createTerminal({
      name: options.name,
      cwd: options.cwd,
      hideFromUser: true,
    });

    const state: NativeSessionState = {
      terminal,
      buffer: '',
      status: 'starting',
      cols,
      rows,
      expectedCommandLine,
      suppressExitCallback: false,
    };

    this.liveSessions.set(options.agentId, state);
    this.terminalToAgentId.set(terminal, options.agentId);
    this.emitSnapshot(options.agentId, state);
    void this.startCommand(options.agentId, options.command, options.args ?? []);

    return {
      terminal,
      snapshot: this.toSnapshot(state),
    };
  }

  hasSession(agentId: number): boolean {
    const session = this.liveSessions.get(agentId);
    return session?.status === 'starting' || session?.status === 'running';
  }

  getSnapshot(agentId: number): EmbeddedTerminalSnapshot | undefined {
    return this.snapshots.get(agentId);
  }

  sendInput(agentId: number, data: string): boolean {
    const session = this.liveSessions.get(agentId);
    if (!session || session.status === 'failed' || session.status === 'exited') {
      return false;
    }

    session.terminal.sendText(data, false);
    return true;
  }

  sendLine(agentId: number, text: string): boolean {
    return this.sendInput(agentId, text.endsWith('\r') ? text : `${text}\r`);
  }

  interrupt(agentId: number): boolean {
    return this.sendInput(agentId, '\u0003');
  }

  resize(agentId: number, cols: number, rows: number): EmbeddedTerminalSnapshot | undefined {
    const session = this.liveSessions.get(agentId);
    if (session) {
      session.cols = cols;
      session.rows = rows;
      this.emitSnapshot(agentId, session);
      return this.toSnapshot(session);
    }

    const snapshot = this.snapshots.get(agentId);
    if (!snapshot) return undefined;

    const nextSnapshot = {
      ...snapshot,
      cols,
      rows,
    };
    this.snapshots.set(agentId, nextSnapshot);
    return nextSnapshot;
  }

  disposeSession(agentId: number): void {
    const session = this.liveSessions.get(agentId);
    this.rejectPendingExecutionStart(agentId, 'The hidden terminal bridge was closed.');
    if (!session) {
      this.snapshots.delete(agentId);
      return;
    }

    session.suppressExitCallback = true;
    this.liveSessions.delete(agentId);
    this.snapshots.delete(agentId);
    this.terminalToAgentId.delete(session.terminal);
    if (session.execution) {
      this.executionToAgentId.delete(session.execution);
    }

    try {
      session.terminal.dispose();
    } catch {
      // Ignore teardown errors while closing the hidden terminal bridge.
    }
  }

  disposeAll(): void {
    for (const agentId of [...this.liveSessions.keys()]) {
      this.disposeSession(agentId);
    }
    this.snapshots.clear();
    this.terminalToAgentId.clear();
    this.executionToAgentId.clear();
    for (const agentId of [...this.pendingExecutionStarts.keys()]) {
      this.rejectPendingExecutionStart(agentId, 'The hidden terminal bridge was closed.');
    }
  }

  dispose(): void {
    this.disposeAll();
    vscode.Disposable.from(...this.disposables).dispose();
  }

  private async startCommand(agentId: number, command: string, args: string[]): Promise<void> {
    const session = this.liveSessions.get(agentId);
    if (!session) return;

    try {
      const shellIntegration = await this.waitForShellIntegration(session.terminal);
      const currentSession = this.liveSessions.get(agentId);
      if (!currentSession || currentSession !== session) {
        return;
      }

      if (process.platform === 'darwin') {
        const executionStart = this.waitForExpectedExecutionStart(agentId);
        currentSession.terminal.sendText(currentSession.expectedCommandLine, true);
        await executionStart;
        return;
      }

      const execution = shellIntegration.executeCommand(command, args);
      this.attachExecution(agentId, currentSession, execution);
    } catch (error) {
      const currentSession = this.liveSessions.get(agentId);
      if (!currentSession || currentSession !== session) {
        return;
      }

      currentSession.status = 'failed';
      currentSession.reason =
        error instanceof Error
          ? error.message
          : 'Failed to start Codex in the hidden terminal bridge.';
      this.emitSnapshot(agentId, currentSession);

      if (currentSession.suppressExitCallback) {
        return;
      }

      this.callbacks.onExit(agentId, {
        reason: currentSession.reason,
      });
    }
  }

  private async waitForShellIntegration(
    terminal: vscode.Terminal,
  ): Promise<vscode.TerminalShellIntegration> {
    if (terminal.shellIntegration) {
      return terminal.shellIntegration;
    }

    return new Promise((resolve, reject) => {
      const shellIntegrationDisposable = vscode.window.onDidChangeTerminalShellIntegration(
        (event) => {
          if (event.terminal !== terminal) return;
          cleanup();
          resolve(event.shellIntegration);
        },
      );

      const closeDisposable = vscode.window.onDidCloseTerminal((closed) => {
        if (closed !== terminal) return;
        cleanup();
        reject(new Error('The hidden terminal bridge closed before shell integration activated.'));
      });

      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            'VS Code shell integration did not activate for the hidden terminal bridge. Use a shell with shell integration enabled, then reopen Pixel Agents.',
          ),
        );
      }, SHELL_INTEGRATION_TIMEOUT_MS);

      const cleanup = () => {
        clearTimeout(timer);
        shellIntegrationDisposable.dispose();
        closeDisposable.dispose();
      };
    });
  }

  private attachExecution(
    agentId: number,
    session: NativeSessionState,
    execution: vscode.TerminalShellExecution,
  ): void {
    if (session.execution === execution) {
      return;
    }

    session.execution = execution;
    session.expectedCommandLine = execution.commandLine.value;
    this.executionToAgentId.set(execution, agentId);
    void this.readExecution(agentId, execution);
  }

  private waitForExpectedExecutionStart(agentId: number): Promise<vscode.TerminalShellExecution> {
    this.rejectPendingExecutionStart(
      agentId,
      'Timed out while waiting for the command to start in the hidden terminal bridge.',
    );

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingExecutionStarts.delete(agentId);
        reject(
          new Error(
            'Timed out while waiting for the command to start in the hidden terminal bridge.',
          ),
        );
      }, SHELL_INTEGRATION_TIMEOUT_MS);

      this.pendingExecutionStarts.set(agentId, {
        timer,
        resolve,
        reject,
      });
    });
  }

  private resolvePendingExecutionStart(
    agentId: number,
    execution: vscode.TerminalShellExecution,
  ): void {
    const pending = this.pendingExecutionStarts.get(agentId);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pendingExecutionStarts.delete(agentId);
    pending.resolve(execution);
  }

  private rejectPendingExecutionStart(agentId: number, reason: string): void {
    const pending = this.pendingExecutionStarts.get(agentId);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pendingExecutionStarts.delete(agentId);
    pending.reject(new Error(reason));
  }

  private async readExecution(
    agentId: number,
    execution: vscode.TerminalShellExecution,
  ): Promise<void> {
    try {
      for await (const data of execution.read()) {
        const session = this.liveSessions.get(agentId);
        if (!session || session.execution !== execution || !data) {
          return;
        }

        session.status = 'running';
        const next = trimBuffer(session.buffer + data);
        session.buffer = next.buffer;
        const snapshot = this.toSnapshot(session);
        this.snapshots.set(agentId, snapshot);

        if (next.truncated) {
          this.callbacks.onSnapshot(agentId, snapshot);
          continue;
        }

        this.callbacks.onData(agentId, data);
      }
    } catch {
      // Ignore read stream errors. The terminal end event drives session teardown.
    }
  }

  private emitSnapshot(agentId: number, session: NativeSessionState): void {
    const snapshot = this.toSnapshot(session);
    this.snapshots.set(agentId, snapshot);
    this.callbacks.onSnapshot(agentId, snapshot);
  }

  private toSnapshot(session: NativeSessionState): EmbeddedTerminalSnapshot {
    return {
      mode: 'embedded',
      status: session.status,
      canInteract: session.status === 'starting' || session.status === 'running',
      buffer: session.buffer,
      cols: session.cols,
      rows: session.rows,
      backend: 'native_terminal',
      exitCode: session.exitCode,
      reason: session.reason,
    };
  }
}
