declare module 'node-pty' {
  export interface IPtyExitEvent {
    exitCode: number;
    signal?: number;
  }

  export interface IPty {
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(signal?: string): void;
    onData(listener: (data: string) => void): void;
    onExit(listener: (event: IPtyExitEvent) => void): void;
  }

  export interface IPtyForkOptions {
    name?: string;
    cols?: number;
    rows?: number;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  }

  export function spawn(file: string, args?: string[], options?: IPtyForkOptions): IPty;
}
