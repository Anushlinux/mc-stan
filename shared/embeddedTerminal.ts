export type TerminalSnapshotBackend = 'native_terminal' | 'vscode_terminal';

export type EmbeddedTerminalMode = 'embedded' | 'inspect_only';

export type EmbeddedTerminalStatus = 'starting' | 'running' | 'failed' | 'exited' | 'unavailable';

export interface EmbeddedTerminalSnapshot {
  mode: EmbeddedTerminalMode;
  status: EmbeddedTerminalStatus;
  canInteract: boolean;
  buffer: string;
  cols: number;
  rows: number;
  backend?: TerminalSnapshotBackend;
  exitCode?: number;
  reason?: string;
}
