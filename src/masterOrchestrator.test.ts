import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { MasterOrchestrator, validatePlannerResult } from './masterOrchestrator.js';

async function createPlannerFixture(
  entries: Array<{ path: string; content?: string }>,
): Promise<string> {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pixel-agents-planner-'));
  await Promise.all(
    entries.map(async (entry) => {
      const targetPath = path.join(repoRoot, entry.path);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, entry.content ?? `${entry.path}\n`, 'utf-8');
    }),
  );
  return repoRoot;
}

test('validatePlannerResult accepts a valid 3-worker split', () => {
  const validation = validatePlannerResult({
    planSummary: 'Split the work across API, state, and UI.',
    sharedConstraints: ['Keep the UI stable'],
    assignments: [
      {
        slot: 1,
        title: 'API',
        goal: 'Update the backend orchestration service.',
        ownedPaths: ['src/masterOrchestrator.ts', 'src/worktreeManager.ts'],
        acceptanceCriteria: ['Planner runs in read-only mode'],
        coordinationNotes: ['Do not edit webview files'],
        dependsOnSlots: [],
      },
      {
        slot: 2,
        title: 'Store',
        goal: 'Extend mission control state.',
        ownedPaths: ['shared/missionControl.ts', 'src/missionControlStore.ts'],
        acceptanceCriteria: ['Snapshot exposes orchestrator state'],
        coordinationNotes: ['Coordinate task shape changes with slot 3'],
        dependsOnSlots: [],
      },
      {
        slot: 3,
        title: 'UI',
        goal: 'Add the master-agent controls to the webview.',
        ownedPaths: ['webview-ui/src/App.tsx', 'webview-ui/src/components'],
        acceptanceCriteria: ['Master launcher opens the control surface'],
        coordinationNotes: ['Do not edit backend files'],
        dependsOnSlots: [2],
      },
    ],
  });

  assert.deepEqual(validation.errors, []);
  assert.equal(validation.result?.assignments.length, 3);
  assert.deepEqual(validation.result?.assignments[2].dependsOnSlots, [2]);
});

test('validatePlannerResult rejects plans that do not contain exactly 3 assignments', () => {
  const validation = validatePlannerResult({
    planSummary: 'Only two workers.',
    sharedConstraints: [],
    assignments: [
      {
        slot: 1,
        title: 'One',
        goal: 'Task one',
        ownedPaths: ['src'],
        acceptanceCriteria: [],
        coordinationNotes: [],
        dependsOnSlots: [],
      },
      {
        slot: 2,
        title: 'Two',
        goal: 'Task two',
        ownedPaths: ['webview-ui/src'],
        acceptanceCriteria: [],
        coordinationNotes: [],
        dependsOnSlots: [],
      },
    ],
  });

  assert.equal(validation.result, undefined);
  assert.match(validation.errors.join('\n'), /exactly 3 items/);
});

test('validatePlannerResult rejects overlapping owned paths', () => {
  const validation = validatePlannerResult({
    planSummary: 'Overlap is invalid.',
    sharedConstraints: [],
    assignments: [
      {
        slot: 1,
        title: 'Core',
        goal: 'Own the whole src tree.',
        ownedPaths: ['src'],
        acceptanceCriteria: [],
        coordinationNotes: [],
        dependsOnSlots: [],
      },
      {
        slot: 2,
        title: 'One file',
        goal: 'Edit one file inside src.',
        ownedPaths: ['src/missionControlStore.ts'],
        acceptanceCriteria: [],
        coordinationNotes: [],
        dependsOnSlots: [],
      },
      {
        slot: 3,
        title: 'UI',
        goal: 'Edit the webview.',
        ownedPaths: ['webview-ui/src'],
        acceptanceCriteria: [],
        coordinationNotes: [],
        dependsOnSlots: [],
      },
    ],
  });

  assert.equal(validation.result, undefined);
  assert.match(validation.errors.join('\n'), /ownedPaths overlap/);
});

test('planWork builds a local 3-worker split from repository areas', async () => {
  const repoRoot = await createPlannerFixture([
    { path: 'src/extension.ts' },
    { path: 'server/src/server.ts' },
    { path: 'shared/missionControl.ts' },
    { path: 'webview-ui/src/App.tsx' },
    { path: 'docs/architecture.md' },
    { path: 'package.json', content: '{ "name": "fixture" }\n' },
  ]);
  const progressMessages: string[] = [];
  const orchestrator = new MasterOrchestrator();

  try {
    const result = await orchestrator.planWork({
      repoRoot,
      baseBranch: 'main',
      userPrompt: 'Add master orchestration and keep current behavior intact.',
      onProgress: (update) => {
        progressMessages.push(update.message);
      },
    });

    assert.equal(result.assignments.length, 3);
    assert.deepEqual(progressMessages, [
      'Scanning repository structure for a local 3-worker split.',
      'Found 5 candidate project areas. Assigning non-overlapping ownership.',
      'Local planner produced a valid 3-worker split.',
    ]);
    assert.ok(
      result.sharedConstraints.includes(
        'Preserve existing UI behavior and visuals unless the request clearly requires UI changes.',
      ),
    );
    assert.ok(result.assignments.every((assignment) => assignment.ownedPaths.length > 0));
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test('planWork can split nested project areas when top-level directories are too few', async () => {
  const repoRoot = await createPlannerFixture([
    { path: 'src/core/index.ts' },
    { path: 'src/store/index.ts' },
    { path: 'src/ui/index.tsx' },
  ]);
  const orchestrator = new MasterOrchestrator();

  try {
    const result = await orchestrator.planWork({
      repoRoot,
      baseBranch: 'main',
      userPrompt: 'Implement a small coordinated feature.',
    });

    assert.equal(result.assignments.length, 3);
    assert.equal(
      new Set(result.assignments.flatMap((assignment) => assignment.ownedPaths)).size,
      3,
    );
    assert.deepEqual(
      result.assignments.map((assignment) => assignment.ownedPaths[0]),
      ['src/core', 'src/store', 'src/ui'],
    );
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});
