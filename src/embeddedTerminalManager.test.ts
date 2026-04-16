import assert from 'node:assert/strict';
import test from 'node:test';

import type { IPty } from 'node-pty';

import type { EmbeddedTerminalSnapshot } from '../shared/embeddedTerminal.js';
import { EmbeddedTerminalManager } from './embeddedTerminalManager.js';

interface FakePty extends Pick<IPty, 'write' | 'resize' | 'kill' | 'onData' | 'onExit'> {
  emitData(data: string): void;
  emitExit(event: { exitCode: number; signal?: number }): void;
  writes: string[];
  resizes: Array<{ cols: number; rows: number }>;
  killed: boolean;
}

function createFakePty(): FakePty {
  const dataListeners: Array<(data: string) => void> = [];
  const exitListeners: Array<(event: { exitCode: number; signal?: number }) => void> = [];

  return {
    writes: [],
    resizes: [],
    killed: false,
    write(data: string): void {
      this.writes.push(data);
    },
    resize(cols: number, rows: number): void {
      this.resizes.push({ cols, rows });
    },
    kill(): void {
      this.killed = true;
    },
    onData(listener: (data: string) => void) {
      dataListeners.push(listener);
      return { dispose() {} };
    },
    onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
      exitListeners.push(listener);
      return { dispose() {} };
    },
    emitData(data: string): void {
      for (const listener of dataListeners) {
        listener(data);
      }
    },
    emitExit(event: { exitCode: number; signal?: number }): void {
      for (const listener of exitListeners) {
        listener(event);
      }
    },
  };
}

function createManager(spawnImpl: () => FakePty) {
  const snapshots: EmbeddedTerminalSnapshot[] = [];
  const streamedData: string[] = [];
  const exits: Array<{ exitCode?: number; signal?: number; reason: string }> = [];

  const manager = new EmbeddedTerminalManager(
    {
      onData: (_agentId, data) => {
        streamedData.push(data);
      },
      onSnapshot: (_agentId, snapshot) => {
        snapshots.push(snapshot);
      },
      onExit: (_agentId, details) => {
        exits.push(details);
      },
    },
    {
      nodePtyModule: {
        spawn: () => spawnImpl() as unknown as IPty,
      },
    },
  );

  return { manager, snapshots, streamedData, exits };
}

test('EmbeddedTerminalManager launches a PTY and becomes running after output starts', () => {
  const pty = createFakePty();
  const { manager, snapshots, streamedData, exits } = createManager(() => pty);

  const snapshot = manager.launchSession({
    agentId: 1,
    cwd: '/tmp',
    command: 'codex',
    args: ['--session-id', 'abc'],
    cols: 100,
    rows: 40,
  });

  assert.equal(snapshot.status, 'starting');
  assert.equal(snapshot.canInteract, true);
  assert.equal(manager.hasSession(1), true);
  assert.equal(snapshots.at(-1)?.status, 'starting');

  pty.emitData('ready\r\n');

  assert.equal(manager.getSnapshot(1)?.status, 'running');
  assert.equal(manager.getSnapshot(1)?.buffer, 'ready\r\n');
  assert.deepEqual(streamedData, ['ready\r\n']);
  assert.deepEqual(exits, []);

  assert.equal(manager.sendInput(1, 'help'), true);
  assert.equal(manager.sendLine(1, 'status'), true);
  assert.deepEqual(pty.writes, ['help', 'status\r']);

  const resized = manager.resize(1, 120, 50);
  assert.equal(resized?.cols, 120);
  assert.equal(resized?.rows, 50);
  assert.deepEqual(pty.resizes, [{ cols: 120, rows: 50 }]);
});

test('EmbeddedTerminalManager reports spawn exceptions as launch failures', () => {
  const snapshots: EmbeddedTerminalSnapshot[] = [];
  const exits: Array<{ exitCode?: number; signal?: number; reason: string }> = [];

  const manager = new EmbeddedTerminalManager(
    {
      onData: () => {},
      onSnapshot: (_agentId, snapshot) => {
        snapshots.push(snapshot);
      },
      onExit: (_agentId, details) => {
        exits.push(details);
      },
    },
    {
      nodePtyModule: {
        spawn: () => {
          throw new Error('posix_spawnp failed');
        },
      },
    },
  );

  const snapshot = manager.launchSession({
    agentId: 2,
    cwd: '/tmp',
    command: 'codex',
  });

  assert.equal(snapshot.status, 'failed');
  assert.equal(snapshot.canInteract, false);
  assert.match(snapshot.reason ?? '', /Failed to launch Codex: posix_spawnp failed/);
  assert.equal(manager.hasSession(2), false);
  assert.equal(snapshots.at(-1)?.status, 'failed');
  assert.equal(exits.length, 1);
  assert.match(exits[0]?.reason ?? '', /Failed to launch Codex: posix_spawnp failed/);
});

test('EmbeddedTerminalManager treats exit during startup as failed startup', () => {
  const pty = createFakePty();
  const { manager, exits } = createManager(() => pty);

  manager.launchSession({
    agentId: 3,
    cwd: '/tmp',
    command: 'codex',
  });

  pty.emitExit({ exitCode: 1 });

  const snapshot = manager.getSnapshot(3);
  assert.equal(snapshot?.status, 'failed');
  assert.equal(snapshot?.canInteract, false);
  assert.equal(snapshot?.exitCode, 1);
  assert.equal(snapshot?.reason, 'Agent failed to start (exit code 1)');
  assert.equal(manager.hasSession(3), false);
  assert.deepEqual(exits, [
    { exitCode: 1, signal: undefined, reason: 'Agent failed to start (exit code 1)' },
  ]);
});

test('EmbeddedTerminalManager treats exit after output as normal session end', () => {
  const pty = createFakePty();
  const { manager, exits } = createManager(() => pty);

  manager.launchSession({
    agentId: 4,
    cwd: '/tmp',
    command: 'codex',
  });

  pty.emitData('booted\r\n');
  pty.emitExit({ exitCode: 0 });

  const snapshot = manager.getSnapshot(4);
  assert.equal(snapshot?.status, 'exited');
  assert.equal(snapshot?.canInteract, false);
  assert.equal(snapshot?.exitCode, 0);
  assert.equal(snapshot?.reason, 'Session ended');
  assert.equal(manager.hasSession(4), false);
  assert.deepEqual(exits, [{ exitCode: 0, signal: undefined, reason: 'Session ended' }]);
});
