import type {
  MissionControlAgentSession,
  MissionControlSnapshot,
  MissionControlTask,
} from '../../../shared/missionControl.ts';
import type { EmbeddedTerminalState } from '../hooks/useExtensionMessages.js';
import { vscode } from '../vscodeApi.js';
import { EmbeddedTerminalPane } from './EmbeddedTerminalPane.js';
import {
  getSessionProgressLabel,
  getSessionTaskLabel,
  getSessionTone,
  humanize,
} from './missionControlUtils.js';
import { Button } from './ui/Button.js';

interface CanvasAgentTerminalDockProps {
  agentId: number | null;
  missionControl: MissionControlSnapshot;
  terminal?: EmbeddedTerminalState;
  isOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
  onOpenMissionControl: (agentId: number) => void;
}

function getSessionForAgent(
  agentId: number,
  missionControl: MissionControlSnapshot,
): MissionControlAgentSession | undefined {
  const activeSessionId = missionControl.activeSessionByAgentId[agentId];
  const sessions = missionControl.sessions.filter((session) => session.agentId === agentId);
  return (
    sessions.find((session) => session.id === activeSessionId) ??
    [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
  );
}

function getTaskForSession(
  session: MissionControlAgentSession | undefined,
  missionControl: MissionControlSnapshot,
): MissionControlTask | undefined {
  if (!session?.taskId) return undefined;
  return missionControl.tasks.find((task) => task.id === session.taskId);
}

function getStatusLabel(
  session: MissionControlAgentSession | undefined,
  terminal: EmbeddedTerminalState | undefined,
): string {
  if (session) return humanize(session.status);
  if (!terminal) return 'Preparing';
  if (terminal.status === 'starting') return 'Launching';
  if (terminal.status === 'running') return 'Connected';
  if (terminal.status === 'failed') return 'Launch failed';
  if (terminal.status === 'exited') return 'Ended';
  return 'Unavailable';
}

function getStatusTone(
  session: MissionControlAgentSession | undefined,
  terminal: EmbeddedTerminalState | undefined,
): string {
  if (session) return getSessionTone(session.status);
  if (terminal?.status === 'failed' || terminal?.status === 'exited') {
    return 'border-status-error/50 text-status-error';
  }
  return 'border-status-active/50 text-status-active';
}

function getProgressLabel(
  session: MissionControlAgentSession | undefined,
  task: MissionControlTask | undefined,
  terminal: EmbeddedTerminalState | undefined,
): string {
  if (session) return getSessionProgressLabel(session, task);
  if (!terminal) return 'Waiting for the terminal to attach.';
  if (terminal.status === 'starting') return 'Booting the Codex session inside the canvas sidebar.';
  if (terminal.status === 'running') return 'Terminal connected. Waiting for session metadata.';
  return terminal.reason ?? 'Interactive terminal unavailable.';
}

export function CanvasAgentTerminalDock({
  agentId,
  missionControl,
  terminal,
  isOpen,
  onOpen,
  onClose,
  onOpenMissionControl,
}: CanvasAgentTerminalDockProps) {
  if (agentId === null) return null;

  const session = getSessionForAgent(agentId, missionControl);
  const task = getTaskForSession(session, missionControl);
  const title = session ? getSessionTaskLabel(session, task) : 'Session startup in progress';
  const agentLabel = session?.displayName ?? `Agent #${agentId}`;
  const statusLabel = getStatusLabel(session, terminal);
  const statusTone = getStatusTone(session, terminal);
  const progressLabel = getProgressLabel(session, task, terminal);

  if (!isOpen) {
    return (
      <button
        type="button"
        className="canvas-terminal-tab pixel-panel absolute right-10 top-20 z-40 flex h-[180px] w-[72px] items-center justify-center px-0 py-8 text-2xs uppercase text-white hover:text-white"
        onClick={onOpen}
        aria-label={`Show terminal for Agent #${agentId}`}
      >
        <span className="canvas-terminal-tab-label">{agentLabel}</span>
      </button>
    );
  }

  return (
    <aside className="canvas-terminal-dock absolute right-10 top-10 bottom-96 z-40 flex w-[440px] min-w-0 flex-col overflow-hidden pixel-panel">
      <div className="flex items-start justify-between gap-6 border-b-2 border-border px-8 py-7">
        <div className="min-w-0">
          <div className="text-2xs uppercase text-text-muted">Canvas Terminal</div>
          <div className="mt-2 text-sm text-white">{agentLabel}</div>
          <div className="mt-2 truncate text-xs text-text-muted">{title}</div>
          <div className="mt-3 text-2xs leading-relaxed text-text-muted">{progressLabel}</div>
        </div>
        <span className={`shrink-0 border px-5 py-2 text-2xs uppercase ${statusTone}`}>
          {statusLabel}
        </span>
      </div>

      <div className="flex flex-wrap gap-4 border-b border-border px-8 py-5">
        <Button size="sm" variant="ghost" onClick={onClose}>
          Hide
        </Button>
        <Button size="sm" onClick={() => onOpenMissionControl(agentId)}>
          Mission Control
        </Button>
        <Button
          size="sm"
          variant="accent"
          onClick={() => vscode.postMessage({ type: 'interruptAgent', id: agentId })}
        >
          Interrupt
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => vscode.postMessage({ type: 'closeAgent', id: agentId })}
        >
          Close Agent
        </Button>
      </div>

      <div className="min-h-0 flex-1">
        <EmbeddedTerminalPane agentId={agentId} terminal={terminal} />
      </div>
    </aside>
  );
}
