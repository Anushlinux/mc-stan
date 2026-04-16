import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef } from 'react';

import type { EmbeddedTerminalState } from '../hooks/useExtensionMessages.js';
import { vscode } from '../vscodeApi.js';
import { Button } from './ui/Button.js';

interface EmbeddedTerminalPaneProps {
  agentId: number;
  terminal: EmbeddedTerminalState | undefined;
  onToggleCollapse?: () => void;
}

function getStatusLabel(terminal: EmbeddedTerminalState | undefined): string {
  if (!terminal) return 'Waiting for session';
  if (terminal.status === 'starting') return 'Launching Codex';
  if (terminal.status === 'running') return terminal.canInteract ? 'Live session' : 'Read only';
  if (terminal.status === 'failed') return terminal.reason ?? 'Agent failed to start';
  if (terminal.status === 'exited') return terminal.reason ?? 'Session ended';
  return terminal.reason ?? 'Interactive session unavailable';
}

export function EmbeddedTerminalPane({
  agentId,
  terminal,
  onToggleCollapse,
}: EmbeddedTerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const lastBufferRef = useRef('');
  const terminalStateRef = useRef<EmbeddedTerminalState | undefined>(terminal);

  useEffect(() => {
    terminalStateRef.current = terminal;
    if (xtermRef.current) {
      xtermRef.current.options.disableStdin = !(terminal?.canInteract ?? false);
    }
  }, [terminal]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const xterm = new Terminal({
      allowTransparency: true,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: 'block',
      fontFamily: '"FS Pixel Sans", monospace',
      fontSize: 14,
      rows: 32,
      cols: 120,
      scrollback: 1000,
      theme: {
        background: 'var(--terminal-bg)',
        foreground: 'var(--terminal-fg)',
        cursor: 'var(--terminal-cursor)',
        cursorAccent: 'var(--terminal-cursor-accent)',
        black: 'var(--terminal-black)',
        red: 'var(--terminal-red)',
        green: 'var(--terminal-green)',
        yellow: 'var(--terminal-yellow)',
        blue: 'var(--terminal-blue)',
        magenta: 'var(--terminal-magenta)',
        cyan: 'var(--terminal-cyan)',
        white: 'var(--terminal-white)',
        brightBlack: 'var(--terminal-bright-black)',
        brightRed: 'var(--terminal-bright-red)',
        brightGreen: 'var(--terminal-bright-green)',
        brightYellow: 'var(--terminal-bright-yellow)',
        brightBlue: 'var(--terminal-bright-blue)',
        brightMagenta: 'var(--terminal-bright-magenta)',
        brightCyan: 'var(--terminal-bright-cyan)',
        brightWhite: 'var(--terminal-bright-white)',
      },
    });
    const fitAddon = new FitAddon();
    xterm.loadAddon(fitAddon);
    xterm.open(container);
    xterm.options.disableStdin = !(terminalStateRef.current?.canInteract ?? false);
    fitAddon.fit();
    xtermRef.current = xterm;
    fitAddonRef.current = fitAddon;

    if (terminalStateRef.current?.buffer) {
      xterm.write(terminalStateRef.current.buffer);
      lastBufferRef.current = terminalStateRef.current.buffer;
    } else {
      lastBufferRef.current = '';
    }

    const pushSize = () => {
      fitAddon.fit();
      vscode.postMessage({
        type: 'terminalResize',
        agentId,
        cols: xterm.cols,
        rows: xterm.rows,
      });
    };

    const resizeObserver = new ResizeObserver(() => {
      pushSize();
    });

    resizeObserver.observe(container);
    pushSize();

    const dataDisposable = xterm.onData((data) => {
      if (!terminalStateRef.current?.canInteract) return;
      vscode.postMessage({
        type: 'terminalInput',
        agentId,
        data,
      });
    });

    return () => {
      dataDisposable.dispose();
      resizeObserver.disconnect();
      fitAddonRef.current = null;
      xtermRef.current?.dispose();
      xtermRef.current = null;
    };
  }, [agentId, terminal?.mode]);

  useEffect(() => {
    const xterm = xtermRef.current;
    const nextBuffer = terminal?.buffer ?? '';
    if (!xterm || nextBuffer === lastBufferRef.current) return;

    if (nextBuffer.startsWith(lastBufferRef.current)) {
      xterm.write(nextBuffer.slice(lastBufferRef.current.length));
    } else {
      xterm.reset();
      if (nextBuffer) {
        xterm.write(nextBuffer);
      }
    }

    lastBufferRef.current = nextBuffer;
  }, [terminal?.buffer, agentId]);

  return (
    <section className="pixel-panel terminal-shell flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <div className="flex items-start justify-between gap-4 border-b border-border px-6 py-5">
        <div className="min-w-0">
          <div className="text-2xs uppercase text-text-muted">Terminal Sidebar</div>
          <div className="mt-2 text-xs leading-relaxed text-white">{getStatusLabel(terminal)}</div>
        </div>
        <div className="flex shrink-0 gap-3">
          {onToggleCollapse ? (
            <Button size="sm" variant="ghost" onClick={onToggleCollapse}>
              Hide
            </Button>
          ) : null}
          <Button
            size="sm"
            onClick={() => xtermRef.current?.focus()}
            disabled={!terminal?.canInteract}
          >
            Focus Input
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              const xterm = xtermRef.current;
              if (!xterm) return;
              xterm.reset();
              if (terminal?.buffer) {
                xterm.write(terminal.buffer);
              }
            }}
          >
            Redraw
          </Button>
        </div>
      </div>

      {terminal?.mode === 'inspect_only' ? (
        <div className="flex flex-1 items-center justify-center px-8 py-8">
          <div className="max-w-[320px] border border-border bg-black/15 px-8 py-8 text-sm leading-relaxed text-text-muted">
            {terminal.reason ?? 'Interactive takeover is unavailable for this session.'}
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 bg-black/30 p-4">
          <div
            ref={containerRef}
            className="terminal-canvas h-full w-full overflow-hidden border border-border bg-black"
          />
        </div>
      )}
    </section>
  );
}
