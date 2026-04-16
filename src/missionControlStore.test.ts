import assert from 'node:assert/strict';
import os from 'node:os';
import test from 'node:test';

import { WORKSPACE_KEY_MISSION_CONTROL } from './constants.js';

class MemoryMemento {
  private readonly values = new Map<string, unknown>();

  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.values.has(key) ? (this.values.get(key) as T) : defaultValue;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

function createExtensionContext(workspaceState = new MemoryMemento()): {
  workspaceState: MemoryMemento;
} {
  return { workspaceState };
}

test('MissionControlStore starts orchestrator runs with phase detail and initial progress', () => {
  const { MissionControlStore } = requireMissionControlStore();
  const context = createExtensionContext();
  const store = new MissionControlStore(context as never);

  store.startOrchestratorRun('Build a small feature', ['Keep the UI stable']);
  const snapshot = store.getSnapshot();

  assert.equal(snapshot.orchestrator.status, 'planning');
  assert.equal(snapshot.orchestrator.currentPhaseLabel, 'Preparing Repository');
  assert.match(snapshot.orchestrator.currentPhaseDetail ?? '', /Collecting repository context/i);
  assert.equal(snapshot.orchestrator.progressEntries.length, 1);
  assert.equal(snapshot.orchestrator.progressEntries[0]?.level, 'info');
});

test('MissionControlStore recovers stale transient orchestrator state on hydrate', () => {
  const { MissionControlStore } = requireMissionControlStore();
  const workspaceState = new MemoryMemento();
  void workspaceState.update(WORKSPACE_KEY_MISSION_CONTROL, {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sessions: [],
    tasks: [],
    approvals: [],
    events: [],
    artifacts: [],
    workspaces: [],
    briefings: [],
    orchestrator: {
      status: 'planning',
      activeRunId: 'run-1',
      lastPrompt: 'Do the thing',
      currentPhaseLabel: 'Planning Split',
      currentPhaseDetail: 'Waiting on planner',
      sharedConstraints: [],
      assignments: [],
      progressEntries: [],
      updatedAt: new Date().toISOString(),
    },
    activeSessionByAgentId: {},
    nextIds: {
      session: 1,
      task: 1,
      approval: 1,
      artifact: 1,
      workspace: 1,
      briefing: 1,
      event: 1,
    },
  });

  const store = new MissionControlStore(createExtensionContext(workspaceState) as never);
  const snapshot = store.hydrate([]);

  assert.equal(snapshot.orchestrator.status, 'failed');
  assert.equal(snapshot.orchestrator.currentPhaseLabel, 'Planning Split');
  assert.match(snapshot.orchestrator.error ?? '', /interrupted while planning/i);
  assert.equal(snapshot.orchestrator.progressEntries.length, 1);
  assert.equal(snapshot.orchestrator.progressEntries[0]?.level, 'warning');
});

test('MissionControlStore marks the orchestrator completed when all worker sessions are idle', () => {
  const { MissionControlStore } = requireMissionControlStore();
  const context = createExtensionContext();
  const store = new MissionControlStore(context as never);
  const runId = store.startOrchestratorRun('Build a feature');
  store.recordOrchestratorPlan(
    runId,
    'Split the work.',
    [],
    [
      {
        slot: 1,
        title: 'Runtime',
        goal: 'Handle runtime work.',
        ownedPaths: ['src/runtime'],
        acceptanceCriteria: [],
        coordinationNotes: [],
        dependsOnSlots: [],
      },
      {
        slot: 2,
        title: 'Shared',
        goal: 'Handle shared work.',
        ownedPaths: ['shared'],
        acceptanceCriteria: [],
        coordinationNotes: [],
        dependsOnSlots: [],
      },
      {
        slot: 3,
        title: 'UI',
        goal: 'Handle UI work.',
        ownedPaths: ['webview-ui/src'],
        acceptanceCriteria: [],
        coordinationNotes: [],
        dependsOnSlots: [],
      },
    ],
  );
  store.recordOrchestratorDispatching(runId);

  const createAgent = (id: number) =>
    ({
      id,
      sessionId: '',
      isExternal: false,
      projectDir: os.tmpdir(),
      cwd: os.tmpdir(),
      activeToolIds: new Set<string>(),
      activeToolStatuses: new Map<string, string>(),
      activeToolNames: new Map<string, string>(),
      activeSubagentToolIds: new Map<string, Set<string>>(),
      activeSubagentToolNames: new Map<string, Map<string, string>>(),
      backgroundAgentToolIds: new Set<string>(),
      isWaiting: false,
      permissionSent: false,
      hadToolsInTurn: false,
      hookDelivered: false,
    }) as any;

  const agents = [createAgent(1), createAgent(2), createAgent(3)];
  for (const agent of agents) {
    store.recordAgentLaunch(agent);
  }

  const snapshotAfterLaunch = store.getSnapshot();
  for (const agent of agents) {
    const sessionId = snapshotAfterLaunch.activeSessionByAgentId[agent.id];
    const session = snapshotAfterLaunch.sessions.find(
      (candidate: { id: string; workspaceAssignmentId?: string }) => candidate.id === sessionId,
    );
    assert.ok(session?.workspaceAssignmentId);
    store.recordOrchestratorAssignmentLaunch(runId, agent.id, {
      agentId: agent.id,
      workspaceAssignmentId: session.workspaceAssignmentId!,
    });
  }

  for (const agent of agents) {
    store.handleHookEvent(agent, 'codex', { hook_event_name: 'Stop' } as never);
  }

  const snapshot = store.getSnapshot();
  assert.equal(snapshot.orchestrator.status, 'completed');
  assert.equal(snapshot.orchestrator.currentPhaseLabel, 'Awaiting Review');
  assert.match(snapshot.orchestrator.currentPhaseDetail ?? '', /review/i);
});

function requireMissionControlStore(): { MissionControlStore: new (...args: any[]) => any } {
  const module = require('./missionControlStore.js') as {
    MissionControlStore?: new (...args: any[]) => any;
    default?: {
      MissionControlStore?: new (...args: any[]) => any;
    };
  };

  const MissionControlStore = module.MissionControlStore ?? module.default?.MissionControlStore;
  assert.ok(MissionControlStore, 'MissionControlStore export should be available in tests');
  return { MissionControlStore };
}
