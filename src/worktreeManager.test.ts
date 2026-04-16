import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { WorktreeManager } from './worktreeManager.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function createRepo(): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-worktree-'));
  git(repoRoot, ['init', '-b', 'main']);
  git(repoRoot, ['config', 'user.email', 'pixel-agents@example.com']);
  git(repoRoot, ['config', 'user.name', 'Pixel Agents']);
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# test repo\n', 'utf-8');
  git(repoRoot, ['add', 'README.md']);
  git(repoRoot, ['commit', '-m', 'init']);
  return repoRoot;
}

test('WorktreeManager provisions 3 isolated worktrees and branches', async () => {
  const repoRoot = createRepo();
  const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-home-'));
  const previousHome = process.env.HOME;
  process.env.HOME = homeRoot;
  const manager = new WorktreeManager();

  try {
    const worktrees = await manager.provision({
      repoRoot,
      runId: 'test-run',
      slots: [{ slot: 1 }, { slot: 2 }, { slot: 3 }],
    });

    assert.equal(worktrees.length, 3);
    assert.deepEqual(
      worktrees.map((worktree) => worktree.slot),
      [1, 2, 3],
    );

    for (const worktree of worktrees) {
      assert.equal(fs.existsSync(worktree.worktreePath), true);
      assert.equal(git(worktree.worktreePath, ['branch', '--show-current']), worktree.branchName);
    }
    await manager.cleanup(repoRoot, worktrees);
  } finally {
    process.env.HOME = previousHome;
    fs.rmSync(homeRoot, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('WorktreeManager rejects dirty tracked working trees', async () => {
  const repoRoot = createRepo();
  const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-home-'));
  const previousHome = process.env.HOME;
  process.env.HOME = homeRoot;
  const manager = new WorktreeManager();
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# dirty repo\n', 'utf-8');

  try {
    await assert.rejects(
      () =>
        manager.provision({
          repoRoot,
          runId: 'dirty-run',
          slots: [{ slot: 1 }, { slot: 2 }, { slot: 3 }],
        }),
      /clean tracked working tree/,
    );
  } finally {
    process.env.HOME = previousHome;
    fs.rmSync(homeRoot, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('WorktreeManager reviews uncommitted worker changes against the main checkout', async () => {
  const repoRoot = createRepo();
  const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-home-'));
  const previousHome = process.env.HOME;
  process.env.HOME = homeRoot;
  const manager = new WorktreeManager();

  try {
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, 'src', 'linkedlist.py'),
      'class LinkedList:\n    pass\n',
      'utf-8',
    );
    git(repoRoot, ['add', 'src/linkedlist.py']);
    git(repoRoot, ['commit', '-m', 'add linked list']);

    const [worktree] = await manager.provision({
      repoRoot,
      runId: 'review-run',
      slots: [{ slot: 1 }],
    });

    fs.writeFileSync(
      path.join(worktree.worktreePath, 'src', 'linkedlist.py'),
      'class LinkedList:\n    def append(self, value):\n        return value\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(worktree.worktreePath, 'src', 'queue.py'),
      'class Queue:\n    pass\n',
      'utf-8',
    );

    const review = await manager.getWorktreeReview({
      repoRoot,
      worktreePath: worktree.worktreePath,
      ownedPaths: ['src'],
    });

    assert.equal(review.hasChanges, true);
    assert.deepEqual(
      review.changedFiles.map((change) => [change.path, change.changeType]),
      [
        ['src/linkedlist.py', 'modified'],
        ['src/queue.py', 'added'],
      ],
    );
    assert.match(review.diff, /linkedlist\.py/);
    assert.match(review.diff, /queue\.py/);

    await manager.cleanup(repoRoot, [worktree]);
  } finally {
    process.env.HOME = previousHome;
    fs.rmSync(homeRoot, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('WorktreeManager applies reviewed worker changes into the main checkout', async () => {
  const repoRoot = createRepo();
  const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-home-'));
  const previousHome = process.env.HOME;
  process.env.HOME = homeRoot;
  const manager = new WorktreeManager();

  try {
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, 'src', 'linkedlist.py'),
      'class LinkedList:\n    pass\n',
      'utf-8',
    );
    git(repoRoot, ['add', 'src/linkedlist.py']);
    git(repoRoot, ['commit', '-m', 'add linked list']);

    const [worktree] = await manager.provision({
      repoRoot,
      runId: 'apply-run',
      slots: [{ slot: 1 }],
    });

    fs.writeFileSync(
      path.join(worktree.worktreePath, 'src', 'linkedlist.py'),
      'class LinkedList:\n    def append(self, value):\n        return value\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(worktree.worktreePath, 'src', 'queue.py'),
      'class Queue:\n    pass\n',
      'utf-8',
    );

    const result = await manager.applyWorktreeChanges({
      repoRoot,
      worktreePath: worktree.worktreePath,
      ownedPaths: ['src'],
    });

    assert.equal(result.hasChanges, true);
    assert.deepEqual(result.appliedFiles.sort(), ['src/linkedlist.py', 'src/queue.py']);
    assert.equal(
      fs.readFileSync(path.join(repoRoot, 'src', 'linkedlist.py'), 'utf-8'),
      'class LinkedList:\n    def append(self, value):\n        return value\n',
    );
    assert.equal(
      fs.readFileSync(path.join(repoRoot, 'src', 'queue.py'), 'utf-8'),
      'class Queue:\n    pass\n',
    );

    await manager.cleanup(repoRoot, [worktree]);
  } finally {
    process.env.HOME = previousHome;
    fs.rmSync(homeRoot, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});
