import * as nodePty from 'node-pty';

import type { EmbeddedTerminalSnapshot } from '../shared/embeddedTerminal.js';

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;
const MAX_BUFFER_CHARS = 200_000;

interface EmbeddedSessionState {
  pty: nodePty.IPty;
  buffer: string;
  status: EmbeddedTerminalSnapshot['status'];
  cols: number;
  rows: number;
  exitCode?: number;
  reason?: string;
  suppressExitCallback: boolean;
}

interface LaunchEmbeddedSessionOptions {
  agentId: number;
  cwd: string;
  command: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  cols?: number;
  rows?: number;
}

interface EmbeddedTerminalManagerCallbacks {
  onData: (agentId: number, data: string) => void;
  onSnapshot: (agentId: number, snapshot: EmbeddedTerminalSnapshot) => void;
  onExit: (
    agentId: number,
    details: {
      exitCode?: number;
      signal?: number;
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
  signal: number | undefined,
): string {
  if (status === 'failed') {
    if (signal !== undefined) {
      return `Agent failed to start (signal ${signal})`;
    }
    if (exitCode !== undefined) {
      return `Agent failed to start (exit code ${exitCode})`;
    }
    return 'Agent failed to start';
  }

  if (signal !== undefined) {
    return `Session ended (${signal})`;
  }
  if (exitCode !== undefined && exitCode !== 0) {
    return `Session ended (exit code ${exitCode})`;
  }
  return 'Session ended';
}

export function createInspectOnlyTerminalSnapshot(
  reason: string,
  cols = DEFAULT_COLS,
  rows = DEFAULT_ROWS,
): EmbeddedTerminalSnapshot {
  return {
    mode: 'inspect_only',
    status: 'unavailable',
    canInteract: false,
    buffer: '',
    cols,
    rows,
    reason,
  };
}

export class EmbeddedTerminalManager {
  private liveSessions = new Map<number, EmbeddedSessionState>();
  private snapshots = new Map<number, EmbeddedTerminalSnapshot>();

  constructor(private readonly callbacks: EmbeddedTerminalManagerCallbacks) {}

  launchSession(options: LaunchEmbeddedSessionOptions): EmbeddedTerminalSnapshot {
    this.disposeSession(options.agentId);

    const cols = options.cols ?? DEFAULT_COLS;
    const rows = options.rows ?? DEFAULT_ROWS;

    let pty: nodePty.IPty;
    try {
      pty = nodePty.spawn(options.command, options.args ?? [], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: options.cwd,
        env: {
          ...process.env,
          ...options.env,
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          COLUMNS: String(cols),
          LINES: String(rows),
        },
      });
    } catch (error) {
      const snapshot: EmbeddedTerminalSnapshot = {
        mode: 'embedded',
        status: 'failed',
        canInteract: false,
        buffer: '',
        cols,
        rows,
        reason: `Failed to launch Codex: ${error instanceof Error ? error.message : String(error)}`,
      };
      this.snapshots.set(options.agentId, snapshot);
      this.callbacks.onSnapshot(options.agentId, snapshot);
      this.callbacks.onExit(options.agentId, {
        reason: snapshot.reason ?? 'Failed to launch Codex',
      });
      return snapshot;
    }

    const state: EmbeddedSessionState = {
      pty,
      buffer: '',
      status: 'starting',
      cols,
      rows,
      suppressExitCallback: false,
    };

    this.liveSessions.set(options.agentId, state);
    this.emitSnapshot(options.agentId, state);

    pty.onData((data) => {
      if (!data) return;

      state.status = 'running';
      const next = trimBuffer(state.buffer + data);
      state.buffer = next.buffer;
      const snapshot = this.toSnapshot(state);
      this.snapshots.set(options.agentId, snapshot);

      if (next.truncated) {
        this.callbacks.onSnapshot(options.agentId, snapshot);
        return;
      }

      this.callbacks.onData(options.agentId, data);
    });

    pty.onExit(({ exitCode, signal }) => {
      const session = this.liveSessions.get(options.agentId);
      if (!session) return;

      const status: EmbeddedTerminalSnapshot['status'] =
        session.status === 'starting' ? 'failed' : 'exited';
      session.status = status;
      session.exitCode = exitCode;
      session.reason = buildReasonForExit(status, exitCode, signal);
      this.emitSnapshot(options.agentId, session);
      this.liveSessions.delete(options.agentId);

      if (session.suppressExitCallback) {
        return;
      }

      this.callbacks.onExit(options.agentId, {
        exitCode,
        signal,
        reason: session.reason,
      });
    });

    return this.toSnapshot(state);
  }

  hasSession(agentId: number): boolean {
    return this.liveSessions.has(agentId);
  }

  getSnapshot(agentId: number): EmbeddedTerminalSnapshot | undefined {
    return this.snapshots.get(agentId);
  }

  setSnapshot(agentId: number, snapshot: EmbeddedTerminalSnapshot): void {
    this.snapshots.set(agentId, snapshot);
    this.callbacks.onSnapshot(agentId, snapshot);
  }

  sendInput(agentId: number, data: string): boolean {
    const session = this.liveSessions.get(agentId);
    if (!session || session.status === 'failed' || session.status === 'exited') {
      return false;
    }

    session.pty.write(data);
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
      session.pty.resize(cols, rows);
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
    if (!session) {
      this.snapshots.delete(agentId);
      return;
    }

    session.suppressExitCallback = true;
    this.liveSessions.delete(agentId);
    this.snapshots.delete(agentId);

    try {
      session.pty.kill();
    } catch {
      // Ignore teardown errors while closing the embedded session.
    }
  }

  disposeAll(): void {
    for (const agentId of [...this.liveSessions.keys()]) {
      this.disposeSession(agentId);
    }
    this.snapshots.clear();
  }

  private emitSnapshot(agentId: number, session: EmbeddedSessionState): void {
    const snapshot = this.toSnapshot(session);
    this.snapshots.set(agentId, snapshot);
    this.callbacks.onSnapshot(agentId, snapshot);
  }

  private toSnapshot(session: EmbeddedSessionState): EmbeddedTerminalSnapshot {
    return {
      mode: 'embedded',
      status: session.status,
      canInteract: session.status === 'starting' || session.status === 'running',
      buffer: session.buffer,
      cols: session.cols,
      rows: session.rows,
      exitCode: session.exitCode,
      reason: session.reason,
    };
  }
}
