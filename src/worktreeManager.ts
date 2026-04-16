import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface PlannedWorktreeSlot {
  slot: number;
}

export interface ProvisionedWorktree {
  slot: number;
  repoRoot: string;
  baseBranch: string;
  branchName: string;
  worktreePath: string;
}

export interface WorkspaceStatusUpdate extends ProvisionedWorktree {
  status: 'provisioning' | 'ready';
}

export interface ProvisionWorktreesInput {
  repoRoot: string;
  runId: string;
  slots: PlannedWorktreeSlot[];
  onStatus?: (update: WorkspaceStatusUpdate) => void | Promise<void>;
}

export interface WorktreeReviewFileChange {
  path: string;
  changeType: 'added' | 'modified' | 'deleted';
  additions?: number;
  deletions?: number;
}

export interface WorktreeReview {
  changedFiles: WorktreeReviewFileChange[];
  diff: string;
  diffTruncated: boolean;
  hasChanges: boolean;
  ownedPaths: string[];
}

export interface WorktreeReviewInput {
  repoRoot: string;
  worktreePath: string;
  ownedPaths: string[];
}

export interface ApplyWorktreeChangesInput extends WorktreeReviewInput {}

export interface ApplyWorktreeChangesResult {
  appliedFiles: string[];
  removedFiles: string[];
  hasChanges: boolean;
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'repo';
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function runGit(repoRoot: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: repoRoot,
    encoding: 'utf-8',
  });
  return stdout.trim();
}

async function runGitAllowDiff(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const result = await execFileAsync('git', args, {
      cwd,
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024 * 8,
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string; message?: string };
    if (failure.code === 1) {
      return {
        stdout: failure.stdout ?? '',
        stderr: failure.stderr ?? '',
        exitCode: 1,
      };
    }
    throw new Error(failure.stderr?.trim() || failure.message || 'Git diff failed.');
  }
}

async function branchExists(repoRoot: string, branchName: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`], {
      cwd: repoRoot,
    });
    return true;
  } catch {
    return false;
  }
}

async function statPath(
  targetPath: string,
): Promise<Awaited<ReturnType<typeof fs.lstat>> | undefined> {
  try {
    return await fs.lstat(targetPath);
  } catch {
    return undefined;
  }
}

async function collectFilesForOwnedPath(
  rootPath: string,
  ownedPath: string,
): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const absoluteOwnedPath = path.join(rootPath, ownedPath);
  const stats = await statPath(absoluteOwnedPath);
  if (!stats) {
    return files;
  }

  if (stats.isFile() || stats.isSymbolicLink()) {
    files.set(ownedPath, absoluteOwnedPath);
    return files;
  }

  if (!stats.isDirectory()) {
    return files;
  }

  const walk = async (currentPath: string, relativePath: string): Promise<void> => {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryAbsolutePath = path.join(currentPath, entry.name);
      const entryRelativePath = path.posix.join(relativePath, entry.name);
      if (entry.isDirectory()) {
        await walk(entryAbsolutePath, entryRelativePath);
        continue;
      }
      if (entry.isFile() || entry.isSymbolicLink()) {
        files.set(entryRelativePath, entryAbsolutePath);
      }
    }
  };

  await walk(absoluteOwnedPath, ownedPath);
  return files;
}

async function fileContentsDiffer(leftPath: string, rightPath: string): Promise<boolean> {
  const [leftBuffer, rightBuffer] = await Promise.all([
    fs.readFile(leftPath),
    fs.readFile(rightPath),
  ]);
  return !leftBuffer.equals(rightBuffer);
}

function normalizeNoIndexDiff(
  patch: string,
  leftAbsolutePath: string | null,
  rightAbsolutePath: string | null,
  relativePath: string,
): string {
  let normalized = patch.replace(/\r\n/g, '\n');
  const targetLabel = relativePath.replace(/\\/g, '/');

  if (leftAbsolutePath) {
    const leftLabel = leftAbsolutePath.replace(/\\/g, '/').replace(/^\//, '');
    normalized = normalized.replaceAll(`a/${leftLabel}`, `a/${targetLabel}`);
  }
  if (rightAbsolutePath) {
    const rightLabel = rightAbsolutePath.replace(/\\/g, '/').replace(/^\//, '');
    normalized = normalized.replaceAll(`b/${rightLabel}`, `b/${targetLabel}`);
    normalized = normalized.replaceAll(`a/${rightLabel}`, `a/${targetLabel}`);
  }

  return normalized;
}

async function buildFilePatch(
  repoRoot: string,
  relativePath: string,
  changeType: WorktreeReviewFileChange['changeType'],
  repoFilePath: string | undefined,
  worktreeFilePath: string | undefined,
): Promise<string> {
  if (changeType === 'added' && worktreeFilePath) {
    const result = await runGitAllowDiff(repoRoot, [
      'diff',
      '--no-index',
      '--binary',
      '--',
      os.devNull,
      worktreeFilePath,
    ]);
    return normalizeNoIndexDiff(result.stdout, null, worktreeFilePath, relativePath);
  }
  if (changeType === 'deleted' && repoFilePath) {
    const result = await runGitAllowDiff(repoRoot, [
      'diff',
      '--no-index',
      '--binary',
      '--',
      repoFilePath,
      os.devNull,
    ]);
    return normalizeNoIndexDiff(result.stdout, repoFilePath, null, relativePath);
  }
  if (repoFilePath && worktreeFilePath) {
    const result = await runGitAllowDiff(repoRoot, [
      'diff',
      '--no-index',
      '--binary',
      '--',
      repoFilePath,
      worktreeFilePath,
    ]);
    return normalizeNoIndexDiff(result.stdout, repoFilePath, worktreeFilePath, relativePath);
  }
  return '';
}

async function ensureParentDirectory(targetPath: string): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
}

export class WorktreeManager {
  async getRepositoryContext(repoRoot: string): Promise<{ repoRoot: string; baseBranch: string }> {
    const resolvedRepoRoot = await runGit(repoRoot, ['rev-parse', '--show-toplevel']);
    const baseBranch =
      (await runGit(resolvedRepoRoot, ['branch', '--show-current'])) ||
      (await runGit(resolvedRepoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']));

    if (!baseBranch || baseBranch === 'HEAD') {
      throw new Error('Master orchestrator requires a named local branch before spawning workers.');
    }

    return {
      repoRoot: resolvedRepoRoot,
      baseBranch,
    };
  }

  async assertCleanTrackedTree(repoRoot: string): Promise<void> {
    const trackedChanges = await runGit(repoRoot, [
      'status',
      '--porcelain',
      '--untracked-files=no',
    ]);
    if (trackedChanges) {
      throw new Error(
        'Master orchestrator requires a clean tracked working tree before creating isolated worker worktrees.',
      );
    }
  }

  async assertCleanTrackedPaths(repoRoot: string, ownedPaths: string[]): Promise<void> {
    if (ownedPaths.length === 0) {
      return;
    }
    const trackedChanges = await runGit(repoRoot, [
      'status',
      '--porcelain',
      '--untracked-files=no',
      '--',
      ...ownedPaths,
    ]);
    if (trackedChanges) {
      throw new Error(
        'The main checkout already has tracked changes inside the selected owned paths. Commit, stash, or revert those paths before applying worker changes.',
      );
    }
  }

  async getWorktreeReview(input: WorktreeReviewInput): Promise<WorktreeReview> {
    const ownedPaths = [
      ...new Set(input.ownedPaths.map((candidate) => candidate.trim()).filter(Boolean)),
    ];
    const repoFiles = new Map<string, string>();
    const worktreeFiles = new Map<string, string>();

    for (const ownedPath of ownedPaths) {
      const [repoEntries, worktreeEntries] = await Promise.all([
        collectFilesForOwnedPath(input.repoRoot, ownedPath),
        collectFilesForOwnedPath(input.worktreePath, ownedPath),
      ]);
      for (const [relativePath, absolutePath] of repoEntries) {
        repoFiles.set(relativePath, absolutePath);
      }
      for (const [relativePath, absolutePath] of worktreeEntries) {
        worktreeFiles.set(relativePath, absolutePath);
      }
    }

    const changedFiles: WorktreeReviewFileChange[] = [];
    const patchParts: string[] = [];
    const allPaths = [...new Set([...repoFiles.keys(), ...worktreeFiles.keys()])].sort(
      (left, right) => left.localeCompare(right),
    );

    for (const relativePath of allPaths) {
      const repoFilePath = repoFiles.get(relativePath);
      const worktreeFilePath = worktreeFiles.get(relativePath);
      let changeType: WorktreeReviewFileChange['changeType'] | undefined;
      if (!repoFilePath && worktreeFilePath) {
        changeType = 'added';
      } else if (repoFilePath && !worktreeFilePath) {
        changeType = 'deleted';
      } else if (repoFilePath && worktreeFilePath) {
        const differs = await fileContentsDiffer(repoFilePath, worktreeFilePath);
        if (differs) {
          changeType = 'modified';
        }
      }

      if (!changeType) {
        continue;
      }

      const patch = await buildFilePatch(
        input.repoRoot,
        relativePath,
        changeType,
        repoFilePath,
        worktreeFilePath,
      );
      const additions = [...patch.matchAll(/^\+(?!\+\+)/gm)].length;
      const deletions = [...patch.matchAll(/^-(?!---)/gm)].length;
      changedFiles.push({
        path: relativePath,
        changeType,
        additions,
        deletions,
      });
      if (patch.trim()) {
        patchParts.push(patch.trimEnd());
      }
    }

    const diff = patchParts.join('\n\n');
    const diffLimit = 60_000;

    return {
      changedFiles,
      diff:
        diff.length > diffLimit ? `${diff.slice(0, diffLimit)}\n\n... diff truncated ...` : diff,
      diffTruncated: diff.length > diffLimit,
      hasChanges: changedFiles.length > 0,
      ownedPaths,
    };
  }

  async applyWorktreeChanges(
    input: ApplyWorktreeChangesInput,
  ): Promise<ApplyWorktreeChangesResult> {
    const review = await this.getWorktreeReview(input);
    if (!review.hasChanges) {
      return { appliedFiles: [], removedFiles: [], hasChanges: false };
    }

    await this.assertCleanTrackedPaths(input.repoRoot, review.ownedPaths);

    const appliedFiles: string[] = [];
    const removedFiles: string[] = [];

    for (const change of review.changedFiles) {
      const sourcePath = path.join(input.worktreePath, change.path);
      const targetPath = path.join(input.repoRoot, change.path);

      if (change.changeType === 'deleted') {
        await fs.rm(targetPath, { recursive: true, force: true });
        removedFiles.push(change.path);
        continue;
      }

      await ensureParentDirectory(targetPath);
      await fs.copyFile(sourcePath, targetPath);
      const sourceStats = await fs.stat(sourcePath);
      await fs.chmod(targetPath, sourceStats.mode);
      appliedFiles.push(change.path);
    }

    return { appliedFiles, removedFiles, hasChanges: true };
  }

  async provision(input: ProvisionWorktreesInput): Promise<ProvisionedWorktree[]> {
    const { repoRoot, baseBranch } = await this.getRepositoryContext(input.repoRoot);
    await this.assertCleanTrackedTree(repoRoot);

    const repoSlug = sanitizeSegment(path.basename(repoRoot));
    const rootDir = path.join(os.homedir(), '.pixel-agents', 'worktrees', repoSlug, input.runId);
    await fs.mkdir(rootDir, { recursive: true });

    const created: ProvisionedWorktree[] = [];

    try {
      for (const slot of [...input.slots].sort((a, b) => a.slot - b.slot)) {
        const branchName = `pixel-agents/${input.runId}/agent-${slot.slot}`;
        const worktreePath = path.join(rootDir, `agent-${slot.slot}`);

        if (await pathExists(worktreePath)) {
          throw new Error(`Worker ${slot.slot} worktree path already exists: ${worktreePath}`);
        }
        if (await branchExists(repoRoot, branchName)) {
          throw new Error(`Worker ${slot.slot} branch already exists: ${branchName}`);
        }

        const worktree: ProvisionedWorktree = {
          slot: slot.slot,
          repoRoot,
          baseBranch,
          branchName,
          worktreePath,
        };

        await input.onStatus?.({ ...worktree, status: 'provisioning' });
        await execFileAsync(
          'git',
          ['worktree', 'add', '-b', branchName, worktreePath, baseBranch],
          { cwd: repoRoot, encoding: 'utf-8' },
        );
        created.push(worktree);
        await input.onStatus?.({ ...worktree, status: 'ready' });
      }

      return created;
    } catch (error) {
      await this.cleanup(repoRoot, created);
      throw error;
    }
  }

  async cleanup(repoRoot: string, worktrees: ProvisionedWorktree[]): Promise<void> {
    for (const worktree of [...worktrees].reverse()) {
      try {
        await execFileAsync('git', ['worktree', 'remove', '--force', worktree.worktreePath], {
          cwd: repoRoot,
          encoding: 'utf-8',
        });
      } catch {
        // Best-effort cleanup only.
      }

      try {
        await execFileAsync('git', ['branch', '-D', worktree.branchName], {
          cwd: repoRoot,
          encoding: 'utf-8',
        });
      } catch {
        // Best-effort cleanup only.
      }

      try {
        await fs.rm(worktree.worktreePath, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup only.
      }
    }
  }
}
