export type EmbeddedTerminalMode = 'embedded' | 'inspect_only';

export type EmbeddedTerminalStatus = 'starting' | 'running' | 'failed' | 'exited' | 'unavailable';

export interface EmbeddedTerminalSnapshot {
  mode: EmbeddedTerminalMode;
  status: EmbeddedTerminalStatus;
  canInteract: boolean;
  buffer: string;
  cols: number;
  rows: number;
  exitCode?: number;
  reason?: string;
}
