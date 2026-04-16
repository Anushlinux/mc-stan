import { useEffect, useMemo, useState } from 'react';

import type {
  MissionControlAgentSession,
  MissionControlOrchestratorAssignment,
  MissionControlOrchestratorProgressEntry,
  MissionControlSnapshot,
  MissionControlTask,
  MissionControlWorkspaceAssignment,
} from '../../../shared/missionControl.ts';
import type { WorkspaceFolder } from '../hooks/useExtensionMessages.js';
import { vscode } from '../vscodeApi.js';
import { Button } from './ui/Button.js';
import { Modal } from './ui/Modal.js';

interface MasterOrchestratorPanelProps {
  missionControl: MissionControlSnapshot;
  onInspectAgent: (agentId: number) => void;
  workspaceFolders: WorkspaceFolder[];
  projectDirectories: WorkspaceFolder[];
}

interface WorkerReviewFileChange {
  path: string;
  changeType: 'added' | 'modified' | 'deleted';
  additions?: number;
  deletions?: number;
}

interface WorkerReviewPayload {
  title: string;
  branchName?: string;
  repoRoot: string;
  worktreePath: string;
  ownedPaths: string[];
  changedFiles: WorkerReviewFileChange[];
  diff: string;
  diffTruncated: boolean;
  hasChanges: boolean;
}

interface WorkerReviewState {
  slot: number;
  loading: boolean;
  applying: boolean;
  review?: WorkerReviewPayload;
  error?: string;
  lastAppliedSummary?: string;
}

interface TeamReviewWorkerPayload extends WorkerReviewPayload {
  slot: number;
}

interface TeamReviewPayload {
  runId?: string;
  workers: TeamReviewWorkerPayload[];
}

interface TeamReviewState {
  loading: boolean;
  applying: boolean;
  review?: TeamReviewPayload;
  error?: string;
  lastAppliedSummary?: string;
}

const fieldClassName =
  'w-full bg-bg-dark/90 border-2 border-border px-8 py-6 text-sm text-text placeholder:text-text-muted outline-none';
const phaseOrder = ['planning', 'provisioning', 'dispatching', 'running'] as const;

function formatElapsed(startedAt: string | undefined, now: number): string | null {
  if (!startedAt) return null;
  const started = new Date(startedAt).getTime();
  if (Number.isNaN(started)) return null;
  const totalSeconds = Math.max(0, Math.floor((now - started) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString()}:${seconds.toString().padStart(2, '0')}`;
}

function formatLogTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function parseList(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function getStatusTone(status: string): string {
  if (
    status === 'planning' ||
    status === 'provisioning' ||
    status === 'dispatching' ||
    status === 'running'
  ) {
    return 'border-status-active/50 text-status-active';
  }
  if (status === 'failed' || status === 'blocked')
    return 'border-status-error/50 text-status-error';
  if (status === 'completed') return 'border-status-success/50 text-status-success';
  return 'border-border text-text-muted';
}

function getLogTone(level: MissionControlOrchestratorProgressEntry['level']): string {
  if (level === 'error') return 'border-status-error/40 bg-status-error/8 text-status-error';
  if (level === 'warning')
    return 'border-status-permission/40 bg-status-permission/8 text-status-permission';
  if (level === 'success')
    return 'border-status-success/40 bg-status-success/8 text-status-success';
  return 'border-border bg-bg-dark/65 text-text';
}

function getCurrentPhaseIndex(orchestrator: MissionControlSnapshot['orchestrator']): number {
  if (orchestrator.status === 'completed' || orchestrator.status === 'running') return 3;
  if (orchestrator.status === 'dispatching') return 2;
  if (orchestrator.status === 'provisioning') return 1;
  const phaseLabel = (orchestrator.currentPhaseLabel ?? '').toLowerCase();
  if (phaseLabel.includes('running')) return 3;
  if (phaseLabel.includes('launch')) return 2;
  if (phaseLabel.includes('provision')) return 1;
  return 0;
}

function getPhaseState(
  phase: (typeof phaseOrder)[number],
  orchestrator: MissionControlSnapshot['orchestrator'],
): 'complete' | 'active' | 'upcoming' {
  const currentPhaseIndex = getCurrentPhaseIndex(orchestrator);
  const phaseIndex = phaseOrder.indexOf(phase);
  if (phaseIndex < currentPhaseIndex) return 'complete';
  if (phaseIndex === currentPhaseIndex && orchestrator.status !== 'idle') return 'active';
  return 'upcoming';
}

function getPhaseLabel(phase: (typeof phaseOrder)[number]): string {
  if (phase === 'planning') return 'Planning';
  if (phase === 'provisioning') return 'Provisioning';
  if (phase === 'dispatching') return 'Dispatching';
  return 'Running';
}

function getChangeTypeLabel(changeType: WorkerReviewFileChange['changeType']): string {
  if (changeType === 'added') return 'Added';
  if (changeType === 'deleted') return 'Deleted';
  return 'Modified';
}

function getChangeTypeTone(changeType: WorkerReviewFileChange['changeType']): string {
  if (changeType === 'added') return 'border-status-success/40 text-status-success';
  if (changeType === 'deleted') return 'border-status-error/40 text-status-error';
  return 'border-status-active/40 text-status-active';
}

function getAssignmentStatus(
  assignment: MissionControlOrchestratorAssignment,
  task: MissionControlTask | undefined,
  session: MissionControlAgentSession | undefined,
): string {
  if (task?.status) return task.status.replace(/_/g, ' ');
  if (session?.status) return session.status.replace(/_/g, ' ');
  if (assignment.agentId) return 'launching';
  return 'planned';
}

function isWorkerQuiescent(status: string | undefined): boolean {
  return (
    status === 'waiting_input' ||
    status === 'blocked' ||
    status === 'paused' ||
    status === 'completed' ||
    status === 'failed' ||
    status === 'stopped'
  );
}

function getWorkspace(
  assignment: MissionControlOrchestratorAssignment,
  workspaces: MissionControlWorkspaceAssignment[],
): MissionControlWorkspaceAssignment | undefined {
  if (!assignment.workspaceAssignmentId) return undefined;
  return workspaces.find((workspace) => workspace.id === assignment.workspaceAssignmentId);
}

export function MasterOrchestratorPanel({
  missionControl,
  onInspectAgent,
  workspaceFolders,
  projectDirectories,
}: MasterOrchestratorPanelProps) {
  const orchestrator = missionControl.orchestrator;
  const [prompt, setPrompt] = useState('');
  const [constraints, setConstraints] = useState('');
  const [selectedDirectory, setSelectedDirectory] = useState('');
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [workerReview, setWorkerReview] = useState<WorkerReviewState | null>(null);
  const [teamReview, setTeamReview] = useState<TeamReviewState | null>(null);
  const [autoOpenedTeamReviewRunId, setAutoOpenedTeamReviewRunId] = useState<string | null>(null);

  const availableDirectories = useMemo(
    () =>
      [...workspaceFolders, ...projectDirectories].filter(
        (folder, index, list) =>
          list.findIndex((candidate) => candidate.path === folder.path) === index,
      ),
    [projectDirectories, workspaceFolders],
  );

  useEffect(() => {
    if (availableDirectories.some((directory) => directory.path === selectedDirectory)) {
      return;
    }
    setSelectedDirectory(availableDirectories[0]?.path ?? '');
  }, [availableDirectories, selectedDirectory]);

  const tasksById = useMemo(
    () => new Map(missionControl.tasks.map((task) => [task.id, task] as const)),
    [missionControl.tasks],
  );
  const sessionsByAgentId = useMemo(
    () => new Map(missionControl.sessions.map((session) => [session.agentId, session] as const)),
    [missionControl.sessions],
  );
  const progressEntries = useMemo(
    () => [...orchestrator.progressEntries].reverse(),
    [orchestrator.progressEntries],
  );
  const workerStatuses = useMemo(
    () =>
      orchestrator.assignments.map((assignment) => {
        const task = assignment.taskId ? tasksById.get(assignment.taskId) : undefined;
        const session = assignment.agentId ? sessionsByAgentId.get(assignment.agentId) : undefined;
        return {
          slot: assignment.slot,
          status: getAssignmentStatus(assignment, task, session),
          launched: !!assignment.agentId,
        };
      }),
    [orchestrator.assignments, sessionsByAgentId, tasksById],
  );
  const allWorkersQuiescent =
    workerStatuses.length > 0 &&
    workerStatuses.every((worker) => worker.launched && isWorkerQuiescent(worker.status));

  const isBusy =
    orchestrator.status === 'planning' ||
    orchestrator.status === 'provisioning' ||
    orchestrator.status === 'dispatching' ||
    orchestrator.status === 'running';
  const canReset =
    orchestrator.status !== 'idle' ||
    orchestrator.assignments.length > 0 ||
    !!orchestrator.lastPlanSummary ||
    !!orchestrator.error;
  let helperText = 'The master will split the request into 3 non-overlapping tracks.';
  if (orchestrator.lastPrompt) {
    helperText = `Last brief: ${orchestrator.lastPrompt}`;
  }
  if (availableDirectories.length === 0) {
    helperText =
      'No working directory is configured yet. Add one here or the extension will prompt when you start.';
  }
  const elapsed = formatElapsed(orchestrator.startedAt, nowTick);

  useEffect(() => {
    if (!isBusy || !orchestrator.startedAt) return;
    const interval = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [isBusy, orchestrator.startedAt]);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const message = event.data;
      if (message.type === 'masterWorkerReviewLoaded') {
        setWorkerReview((current) =>
          current && current.slot === (message.slot as number)
            ? {
                ...current,
                loading: false,
                applying: false,
                review: message.review as WorkerReviewPayload,
                error: undefined,
              }
            : current,
        );
      } else if (message.type === 'masterWorkerReviewFailed') {
        setWorkerReview((current) =>
          current && current.slot === (message.slot as number)
            ? {
                ...current,
                loading: false,
                applying: false,
                error: message.error as string,
              }
            : current,
        );
      } else if (message.type === 'masterWorkerReviewApplied') {
        setWorkerReview((current) =>
          current && current.slot === (message.slot as number)
            ? {
                ...current,
                applying: false,
                loading: true,
                error: undefined,
                lastAppliedSummary: (() => {
                  const result = message.result as {
                    appliedFiles: string[];
                    removedFiles: string[];
                    hasChanges: boolean;
                  };
                  if (!result.hasChanges) return 'No pending worker changes were left to apply.';
                  return `Applied ${result.appliedFiles.length.toString()} file(s) and removed ${result.removedFiles.length.toString()} file(s) in the main checkout.`;
                })(),
              }
            : current,
        );
        const slot = message.slot as number;
        vscode.postMessage({ type: 'loadMasterWorkerReview', slot });
      } else if (message.type === 'masterWorkerReviewApplyFailed') {
        setWorkerReview((current) =>
          current && current.slot === (message.slot as number)
            ? {
                ...current,
                applying: false,
                error: message.error as string,
              }
            : current,
        );
      } else if (message.type === 'masterTeamReviewLoaded') {
        setTeamReview((current) => ({
          loading: false,
          applying: false,
          review: message.review as TeamReviewPayload,
          error: undefined,
          lastAppliedSummary: current?.lastAppliedSummary,
        }));
      } else if (message.type === 'masterTeamReviewFailed') {
        setTeamReview((current) =>
          current
            ? {
                ...current,
                loading: false,
                applying: false,
                error: message.error as string,
              }
            : {
                loading: false,
                applying: false,
                error: message.error as string,
              },
        );
      } else if (message.type === 'masterTeamReviewApplied') {
        const result = message.result as {
          totalAppliedFiles: number;
          totalRemovedFiles: number;
        };
        setTeamReview((current) =>
          current
            ? {
                ...current,
                loading: true,
                applying: false,
                error: undefined,
                lastAppliedSummary: `Applied ${result.totalAppliedFiles.toString()} file(s) and removed ${result.totalRemovedFiles.toString()} file(s) in the main checkout. The repo is now ready for commit review.`,
              }
            : current,
        );
        vscode.postMessage({ type: 'loadMasterTeamReview' });
      } else if (message.type === 'masterTeamReviewApplyFailed') {
        setTeamReview((current) =>
          current
            ? {
                ...current,
                applying: false,
                error: message.error as string,
              }
            : {
                loading: false,
                applying: false,
                error: message.error as string,
              },
        );
      }
    };

    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  useEffect(() => {
    if (
      !allWorkersQuiescent ||
      !orchestrator.activeRunId ||
      autoOpenedTeamReviewRunId === orchestrator.activeRunId ||
      teamReview ||
      workerReview
    ) {
      return;
    }

    setAutoOpenedTeamReviewRunId(orchestrator.activeRunId);
    setTeamReview({
      loading: true,
      applying: false,
    });
    vscode.postMessage({ type: 'loadMasterTeamReview' });
  }, [
    allWorkersQuiescent,
    autoOpenedTeamReviewRunId,
    orchestrator.activeRunId,
    teamReview,
    workerReview,
  ]);

  const handleStart = () => {
    if (!prompt.trim() || isBusy) return;
    vscode.postMessage({
      type: 'startMasterOrchestration',
      prompt: prompt.trim(),
      extraConstraints: parseList(constraints),
      folderPath: selectedDirectory || undefined,
    });
    setPrompt('');
    setConstraints('');
  };

  const openWorkerReview = (assignment: MissionControlOrchestratorAssignment) => {
    setWorkerReview({
      slot: assignment.slot,
      loading: true,
      applying: false,
      review: undefined,
      error: undefined,
    });
    vscode.postMessage({
      type: 'loadMasterWorkerReview',
      slot: assignment.slot,
    });
  };

  const refreshWorkerReview = () => {
    if (!workerReview) return;
    setWorkerReview({
      ...workerReview,
      loading: true,
      applying: false,
      error: undefined,
    });
    vscode.postMessage({
      type: 'loadMasterWorkerReview',
      slot: workerReview.slot,
    });
  };

  const approveWorkerReview = () => {
    if (!workerReview || workerReview.loading || workerReview.applying) return;
    setWorkerReview({
      ...workerReview,
      applying: true,
      error: undefined,
    });
    vscode.postMessage({
      type: 'applyMasterWorkerChanges',
      slot: workerReview.slot,
    });
  };

  const openTeamReview = () => {
    setTeamReview({
      loading: true,
      applying: false,
      error: undefined,
    });
    vscode.postMessage({ type: 'loadMasterTeamReview' });
  };

  const refreshTeamReview = () => {
    if (!teamReview) return;
    setTeamReview({
      ...teamReview,
      loading: true,
      applying: false,
      error: undefined,
    });
    vscode.postMessage({ type: 'loadMasterTeamReview' });
  };

  const approveTeamReview = () => {
    if (!teamReview || teamReview.loading || teamReview.applying) return;
    setTeamReview({
      ...teamReview,
      applying: true,
      error: undefined,
    });
    vscode.postMessage({ type: 'applyMasterTeamReview' });
  };

  return (
    <div className="h-full w-full min-w-0 overflow-y-auto overflow-x-hidden px-12 py-12 pb-16">
      <section className="pixel-panel bg-bg-dark/55 px-10 py-10">
        <div className="flex flex-wrap items-start justify-between gap-8">
          <div className="min-w-0">
            <div className="text-lg text-white">Master Orchestrator</div>
            <div className="mt-2 max-w-[720px] text-2xs leading-relaxed text-text-muted">
              The master does not execute code. It plans the work, provisions three isolated worker
              sessions, and keeps the team split aligned.
            </div>
          </div>
          <span
            className={`border px-6 py-2 text-2xs uppercase ${getStatusTone(orchestrator.status)}`}
          >
            {orchestrator.status}
          </span>
        </div>

        <div className="mt-8 grid gap-6">
          <textarea
            className={`${fieldClassName} min-h-[132px]`}
            placeholder="What should the three-worker team build?"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            disabled={isBusy}
          />
          <textarea
            className={`${fieldClassName} min-h-[82px] text-2xs`}
            placeholder="Optional extra constraints, one per line"
            value={constraints}
            onChange={(event) => setConstraints(event.target.value)}
            disabled={isBusy}
          />
          <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto]">
            <select
              className={fieldClassName}
              value={selectedDirectory}
              onChange={(event) => setSelectedDirectory(event.target.value)}
              disabled={isBusy || availableDirectories.length === 0}
            >
              {availableDirectories.length === 0 ? (
                <option value="">Pick a project directory or open a workspace</option>
              ) : null}
              {availableDirectories.map((directory) => (
                <option key={directory.path} value={directory.path}>
                  {directory.source === 'project'
                    ? `[Added] ${directory.name}`
                    : `[Workspace] ${directory.name}`}
                </option>
              ))}
            </select>
            <Button
              variant="ghost"
              onClick={() => vscode.postMessage({ type: 'addProjectDirectory' })}
              disabled={isBusy}
            >
              Add Directory
            </Button>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-6">
            <div className="text-2xs text-text-muted">{helperText}</div>
            <div className="flex flex-wrap items-center gap-4">
              {canReset ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => vscode.postMessage({ type: 'resetMasterOrchestrator' })}
                >
                  Reset Master
                </Button>
              ) : null}
              <Button variant="accent" onClick={handleStart} disabled={!prompt.trim() || isBusy}>
                {isBusy ? 'Orchestrating' : 'Start 3-worker run'}
              </Button>
            </div>
          </div>
          {orchestrator.error ? (
            <div className="border border-status-error/40 bg-status-error/8 px-8 py-6 text-2xs text-status-error">
              {orchestrator.error}
            </div>
          ) : null}

          <div className="grid gap-6 xl:grid-cols-[280px_minmax(0,1fr)]">
            <div className="pixel-panel bg-bg-dark/45 px-8 py-8">
              <div className="text-sm text-white">Phase Timeline</div>
              <div className="mt-6 grid gap-4">
                {phaseOrder.map((phase) => {
                  const phaseState = getPhaseState(phase, orchestrator);
                  const toneClass =
                    phaseState === 'complete'
                      ? 'border-status-success/40 text-status-success'
                      : phaseState === 'active'
                        ? 'border-status-active/40 text-status-active'
                        : 'border-border text-text-muted';

                  return (
                    <div key={phase} className={`border px-6 py-5 text-2xs uppercase ${toneClass}`}>
                      {getPhaseLabel(phase)}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="pixel-panel bg-bg-dark/45 px-8 py-8">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="text-sm text-white">
                    {orchestrator.currentPhaseLabel ?? 'Waiting for a run'}
                  </div>
                  <div className="mt-2 text-2xs leading-relaxed text-text-muted">
                    {orchestrator.currentPhaseDetail ??
                      'Progress updates will appear here while the master is working.'}
                  </div>
                </div>
                {elapsed ? (
                  <span className="border border-border px-5 py-2 text-2xs uppercase text-text-muted">
                    {elapsed}
                  </span>
                ) : null}
              </div>

              <div className="mt-6 max-h-[260px] overflow-y-auto pr-2">
                <div className="grid gap-3">
                  {progressEntries.length > 0 ? (
                    progressEntries.map((entry) => (
                      <div key={entry.id} className={`border px-6 py-5 ${getLogTone(entry.level)}`}>
                        <div className="flex items-center justify-between gap-4 text-2xs uppercase">
                          <span>{entry.level}</span>
                          <span className="text-text-muted">
                            {formatLogTimestamp(entry.timestamp)}
                          </span>
                        </div>
                        <div className="mt-2 text-2xs leading-relaxed">{entry.message}</div>
                      </div>
                    ))
                  ) : (
                    <div className="border border-border px-6 py-5 text-2xs text-text-muted">
                      No live progress yet. Start a run to watch the master phases update here.
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {orchestrator.lastPlanSummary ? (
        <section className="mt-12 pixel-panel bg-bg-dark/55 px-10 py-10">
          <div className="text-lg text-white">Current plan</div>
          <div className="mt-3 text-sm leading-relaxed text-text">
            {orchestrator.lastPlanSummary}
          </div>
          {orchestrator.sharedConstraints.length > 0 ? (
            <div className="mt-6 flex flex-wrap gap-3 text-2xs text-text-muted">
              {orchestrator.sharedConstraints.map((constraint) => (
                <span key={constraint} className="border border-border px-4 py-2">
                  {constraint}
                </span>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="mt-12">
        <div className="mb-6 flex items-center justify-between gap-6">
          <div>
            <div className="text-lg text-white">Worker assignments</div>
            <div className="mt-2 text-2xs text-text-muted">
              Each worker owns a separate worktree and a separate path budget.
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            {allWorkersQuiescent ? (
              <Button size="sm" variant="accent" onClick={openTeamReview}>
                Team Review
              </Button>
            ) : null}
            <span className="border border-border px-6 py-2 text-2xs uppercase text-text-muted">
              {orchestrator.assignments.length} planned
            </span>
          </div>
        </div>

        <div className="grid gap-6 xl:grid-cols-3">
          {orchestrator.assignments.length > 0 ? (
            orchestrator.assignments.map((assignment) => {
              const task = assignment.taskId ? tasksById.get(assignment.taskId) : undefined;
              const session = assignment.agentId
                ? sessionsByAgentId.get(assignment.agentId)
                : undefined;
              const workspace = getWorkspace(assignment, missionControl.workspaces);
              const status = getAssignmentStatus(assignment, task, session);

              return (
                <div key={assignment.slot} className="pixel-panel bg-bg-dark/55 px-10 py-10">
                  <div className="flex items-start justify-between gap-8">
                    <div className="min-w-0">
                      <div className="text-sm uppercase text-text-muted">
                        Worker {assignment.slot}
                      </div>
                      <div className="mt-3 text-lg text-white">{assignment.title}</div>
                    </div>
                    <span
                      className={`border px-5 py-2 text-2xs uppercase ${getStatusTone(status)}`}
                    >
                      {status}
                    </span>
                  </div>

                  <div className="mt-4 text-2xs leading-relaxed text-text-muted">
                    {assignment.goal}
                  </div>

                  <div className="mt-6">
                    <div className="text-2xs uppercase text-text-muted">Owned paths</div>
                    <div className="mt-3 flex flex-wrap gap-3 text-2xs text-text">
                      {assignment.ownedPaths.map((ownedPath) => (
                        <span key={ownedPath} className="border border-border px-4 py-2">
                          {ownedPath}
                        </span>
                      ))}
                    </div>
                  </div>

                  {assignment.acceptanceCriteria.length > 0 ? (
                    <div className="mt-6">
                      <div className="text-2xs uppercase text-text-muted">Acceptance</div>
                      <div className="mt-3 grid gap-2 text-2xs text-text">
                        {assignment.acceptanceCriteria.map((item) => (
                          <div key={item}>- {item}</div>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {workspace ? (
                    <div className="mt-6 grid gap-2 text-2xs text-text-muted">
                      <div>Status: {workspace.status.replace(/_/g, ' ')}</div>
                      <div>Branch: {workspace.branchName ?? 'Unknown'}</div>
                      <div className="break-all">Worktree: {workspace.worktreePath}</div>
                    </div>
                  ) : null}

                  {assignment.agentId || workspace ? (
                    <div className="mt-8 flex flex-wrap gap-4">
                      {workspace ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => openWorkerReview(assignment)}
                        >
                          Review Changes
                        </Button>
                      ) : null}
                      {assignment.agentId ? (
                        <Button size="sm" onClick={() => onInspectAgent(assignment.agentId!)}>
                          Inspect Agent
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })
          ) : (
            <div className="pixel-panel bg-bg-dark/55 px-10 py-10 text-sm text-text-muted xl:col-span-3">
              No active master plan yet.
            </div>
          )}
        </div>
      </section>

      <Modal
        isOpen={!!workerReview}
        onClose={() => setWorkerReview(null)}
        title={workerReview ? `Review Worker ${workerReview.slot}` : 'Review Worker'}
        className="w-[min(1120px,92vw)] max-h-[88vh] overflow-hidden p-0"
        zIndex={70}
      >
        <div className="flex h-full flex-col px-10 pb-10">
          {workerReview?.loading ? (
            <div className="py-14 text-sm text-text-muted">
              Loading worker diff against the main checkout...
            </div>
          ) : null}

          {!workerReview?.loading && workerReview?.error ? (
            <div className="border border-status-error/40 bg-status-error/8 px-8 py-6 text-2xs text-status-error">
              {workerReview.error}
            </div>
          ) : null}

          {!workerReview?.loading && workerReview?.review ? (
            <>
              <div className="grid gap-3 text-2xs text-text-muted">
                <div className="text-sm text-white">{workerReview.review.title}</div>
                <div>Branch: {workerReview.review.branchName ?? 'Unknown'}</div>
                <div className="break-all">Main repo: {workerReview.review.repoRoot}</div>
                <div className="break-all">Worker worktree: {workerReview.review.worktreePath}</div>
              </div>

              {workerReview.lastAppliedSummary ? (
                <div className="mt-6 border border-status-success/40 bg-status-success/8 px-8 py-6 text-2xs text-status-success">
                  {workerReview.lastAppliedSummary}
                </div>
              ) : null}

              <div className="mt-8">
                <div className="flex items-center justify-between gap-4">
                  <div className="text-sm text-white">Changed Files</div>
                  <span className="border border-border px-5 py-2 text-2xs uppercase text-text-muted">
                    {workerReview.review.changedFiles.length} files
                  </span>
                </div>
                {workerReview.review.hasChanges ? (
                  <div className="mt-4 grid gap-3">
                    {workerReview.review.changedFiles.map((change) => (
                      <div
                        key={`${change.changeType}:${change.path}`}
                        className="border border-border bg-bg-dark/55 px-6 py-5"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-4">
                          <div className="min-w-0 text-2xs text-text break-all">{change.path}</div>
                          <span
                            className={`border px-4 py-2 text-2xs uppercase ${getChangeTypeTone(change.changeType)}`}
                          >
                            {getChangeTypeLabel(change.changeType)}
                          </span>
                        </div>
                        <div className="mt-3 text-2xs text-text-muted">
                          +{change.additions ?? 0} / -{change.deletions ?? 0}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="mt-4 border border-border px-6 py-5 text-2xs text-text-muted">
                    This worker does not have any pending file changes relative to the main
                    checkout.
                  </div>
                )}
              </div>

              <div className="mt-8">
                <div className="flex items-center justify-between gap-4">
                  <div className="text-sm text-white">Patch Preview</div>
                  {workerReview.review.diffTruncated ? (
                    <span className="border border-status-permission/40 px-4 py-2 text-2xs uppercase text-status-permission">
                      Truncated
                    </span>
                  ) : null}
                </div>
                <div className="mt-4 max-h-[380px] overflow-auto border border-border bg-black/25">
                  <pre className="min-w-full whitespace-pre-wrap px-6 py-6 font-mono text-[11px] leading-relaxed text-text">
                    {workerReview.review.diff || 'No patch to show.'}
                  </pre>
                </div>
              </div>
            </>
          ) : null}

          <div className="mt-8 flex flex-wrap justify-end gap-4">
            <Button size="sm" variant="ghost" onClick={() => setWorkerReview(null)}>
              Close
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={refreshWorkerReview}
              disabled={!workerReview || workerReview.loading || workerReview.applying}
            >
              Refresh
            </Button>
            <Button
              size="sm"
              variant="accent"
              onClick={approveWorkerReview}
              disabled={
                !workerReview?.review?.hasChanges || workerReview.loading || workerReview.applying
              }
            >
              {workerReview?.applying ? 'Applying' : 'Approve And Apply'}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={!!teamReview}
        onClose={() => setTeamReview(null)}
        title="Team Review"
        className="w-[min(1220px,94vw)] max-h-[90vh] overflow-hidden p-0"
        zIndex={72}
      >
        <div className="flex h-full flex-col px-10 pb-10">
          {teamReview?.loading ? (
            <div className="py-14 text-sm text-text-muted">
              Loading the combined worker review from isolated worktrees...
            </div>
          ) : null}

          {!teamReview?.loading && teamReview?.error ? (
            <div className="border border-status-error/40 bg-status-error/8 px-8 py-6 text-2xs text-status-error">
              {teamReview.error}
            </div>
          ) : null}

          {!teamReview?.loading && teamReview?.review ? (
            <>
              <div className="grid gap-3 text-2xs text-text-muted">
                <div className="text-sm text-white">
                  All workers are idle. Review the isolated changes below before applying them to
                  the main checkout.
                </div>
                <div>Run: {teamReview.review.runId ?? orchestrator.activeRunId ?? 'Unknown'}</div>
              </div>

              {teamReview.lastAppliedSummary ? (
                <div className="mt-6 border border-status-success/40 bg-status-success/8 px-8 py-6 text-2xs text-status-success">
                  {teamReview.lastAppliedSummary}
                </div>
              ) : null}

              <div className="mt-8 max-h-[58vh] overflow-y-auto pr-2">
                <div className="grid gap-6">
                  {teamReview.review.workers.map((worker) => (
                    <div key={worker.slot} className="border border-border bg-bg-dark/45 px-8 py-8">
                      <div className="flex flex-wrap items-start justify-between gap-4">
                        <div>
                          <div className="text-2xs uppercase text-text-muted">
                            Worker {worker.slot}
                          </div>
                          <div className="mt-2 text-sm text-white">{worker.title}</div>
                        </div>
                        <span className="border border-border px-4 py-2 text-2xs uppercase text-text-muted">
                          {worker.changedFiles.length} files
                        </span>
                      </div>

                      <div className="mt-4 grid gap-2 text-2xs text-text-muted">
                        <div>Branch: {worker.branchName ?? 'Unknown'}</div>
                        <div className="break-all">Worktree: {worker.worktreePath}</div>
                      </div>

                      {worker.hasChanges ? (
                        <>
                          <div className="mt-6 grid gap-3">
                            {worker.changedFiles.map((change) => (
                              <div
                                key={`${worker.slot}:${change.changeType}:${change.path}`}
                                className="border border-border px-5 py-4"
                              >
                                <div className="flex flex-wrap items-center justify-between gap-3">
                                  <div className="min-w-0 break-all text-2xs text-text">
                                    {change.path}
                                  </div>
                                  <span
                                    className={`border px-4 py-2 text-2xs uppercase ${getChangeTypeTone(change.changeType)}`}
                                  >
                                    {getChangeTypeLabel(change.changeType)}
                                  </span>
                                </div>
                                <div className="mt-2 text-2xs text-text-muted">
                                  +{change.additions ?? 0} / -{change.deletions ?? 0}
                                </div>
                              </div>
                            ))}
                          </div>

                          <div className="mt-6">
                            <div className="flex items-center justify-between gap-4">
                              <div className="text-2xs uppercase text-text-muted">
                                Patch Preview
                              </div>
                              {worker.diffTruncated ? (
                                <span className="border border-status-permission/40 px-4 py-2 text-2xs uppercase text-status-permission">
                                  Truncated
                                </span>
                              ) : null}
                            </div>
                            <div className="mt-3 max-h-[260px] overflow-auto border border-border bg-black/25">
                              <pre className="min-w-full whitespace-pre-wrap px-6 py-6 font-mono text-[11px] leading-relaxed text-text">
                                {worker.diff || 'No patch to show.'}
                              </pre>
                            </div>
                          </div>
                        </>
                      ) : (
                        <div className="mt-6 border border-border px-6 py-5 text-2xs text-text-muted">
                          No pending worker changes relative to the main checkout.
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </>
          ) : null}

          <div className="mt-8 flex flex-wrap justify-end gap-4">
            <Button size="sm" variant="ghost" onClick={() => setTeamReview(null)}>
              Close
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={refreshTeamReview}
              disabled={!teamReview || teamReview.loading || teamReview.applying}
            >
              Refresh
            </Button>
            <Button
              size="sm"
              variant="accent"
              onClick={approveTeamReview}
              disabled={
                !teamReview?.review?.workers.some((worker) => worker.hasChanges) ||
                teamReview.loading ||
                teamReview.applying
              }
            >
              {teamReview?.applying ? 'Applying' : 'Approve For Commit'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
