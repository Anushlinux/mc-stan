import * as fs from 'fs/promises';
import * as path from 'path';

export interface MasterPlannerProgressUpdate {
  message: string;
  level?: 'info' | 'success' | 'warning' | 'error';
  phaseLabel?: string;
  phaseDetail?: string;
}

export interface MasterPlannerAssignment {
  slot: number;
  title: string;
  goal: string;
  ownedPaths: string[];
  acceptanceCriteria: string[];
  coordinationNotes: string[];
  dependsOnSlots: number[];
}

export interface MasterPlannerResult {
  planSummary: string;
  sharedConstraints: string[];
  assignments: MasterPlannerAssignment[];
}

export interface PlanWorkInput {
  repoRoot: string;
  baseBranch: string;
  userPrompt: string;
  extraConstraints?: string[];
  repoAreaHints?: string[];
  onProgress?: (update: MasterPlannerProgressUpdate) => void;
}

interface PlanningCandidate {
  path: string;
  source: 'top-level-dir' | 'nested-dir' | 'top-level-file' | 'nested-file';
}

interface PlannerBucket {
  slot: number;
  theme: 'runtime' | 'shared' | 'ui';
  ownedPaths: string[];
}

const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
  '.next',
  '.nuxt',
  '.turbo',
  '.vscode',
  'coverage',
  'build',
  'dist',
  'out',
  'tmp',
  'temp',
  'node_modules',
]);

const IGNORED_FILES = new Set(['.ds_store', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']);

const THEME_KEYWORDS: Record<PlannerBucket['theme'], string[]> = {
  runtime: [
    'src',
    'server',
    'backend',
    'api',
    'agent',
    'terminal',
    'provider',
    'hook',
    'runtime',
    'extension',
    'codex',
    'claude',
  ],
  shared: [
    'shared',
    'state',
    'store',
    'types',
    'config',
    'constants',
    'docs',
    'scripts',
    'test',
    'spec',
    'fixture',
    'package.json',
    'readme',
  ],
  ui: [
    'webview',
    'ui',
    'app',
    'component',
    'browser',
    'public',
    'asset',
    'style',
    'css',
    'office',
    'view',
    'screen',
  ],
};

function splitLines(lines: string[] | undefined): string[] {
  return (lines ?? []).map((line) => line.trim()).filter(Boolean);
}

function normalizeOwnedPath(value: string): string {
  const unix = value.replace(/\\/g, '/').trim();
  if (!unix) return '';

  const withoutDot = unix.replace(/^\.\/+/, '');
  const normalized = path.posix.normalize(withoutDot);
  if (
    !normalized ||
    normalized === '.' ||
    normalized.startsWith('../') ||
    path.posix.isAbsolute(normalized)
  ) {
    return '';
  }

  return normalized.replace(/\/$/, '');
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function isIgnoredDirectory(name: string): boolean {
  return name.startsWith('.') || IGNORED_DIRECTORIES.has(name);
}

function isIgnoredFile(name: string): boolean {
  return name.startsWith('.') || IGNORED_FILES.has(name);
}

function summarizePaths(paths: string[]): string {
  if (paths.length === 0) return 'the assigned project area';
  if (paths.length === 1) return paths[0];
  if (paths.length === 2) return `${paths[0]} and ${paths[1]}`;
  return `${paths[0]}, ${paths[1]}, and ${paths.length - 2} more area(s)`;
}

function scoreCandidateForTheme(candidatePath: string, theme: PlannerBucket['theme']): number {
  const lowerPath = candidatePath.toLowerCase();
  return THEME_KEYWORDS[theme].reduce(
    (score, keyword) => (lowerPath.includes(keyword) ? score + 2 : score),
    0,
  );
}

function getAssignmentTitle(bucket: PlannerBucket): string {
  if (bucket.theme === 'ui') return 'UI and Interaction';
  if (bucket.theme === 'shared') return 'Shared State and Support';
  return 'Runtime and Agent Flow';
}

function getAssignmentGoal(bucket: PlannerBucket, operatorPrompt: string): string {
  return [
    `Advance the operator request inside ${summarizePaths(bucket.ownedPaths)}.`,
    `Keep all edits scoped to the owned paths for worker ${bucket.slot}.`,
    `Operator request: ${operatorPrompt.trim()}`,
  ].join(' ');
}

function getAcceptanceCriteria(
  bucket: PlannerBucket,
  preserveUiConstraint: string | undefined,
): string[] {
  const criteria = [
    `Deliver the requested change inside ${summarizePaths(bucket.ownedPaths)} only.`,
    'Leave a clear blocker instead of editing another worker’s owned paths.',
  ];
  if (bucket.theme === 'ui' && preserveUiConstraint) {
    criteria.push(preserveUiConstraint);
  }
  return criteria;
}

function getCoordinationNotes(
  bucket: PlannerBucket,
  preserveUiConstraint: string | undefined,
): string[] {
  const notes = [
    'Do not edit files or directories owned by another worker.',
    'If a required change falls outside your ownership, stop and report the blocker clearly.',
  ];
  if (bucket.theme === 'shared') {
    notes.push(
      'Keep interfaces explicit so the runtime and UI tracks can integrate without path overlap.',
    );
  }
  if (bucket.theme === 'ui' && preserveUiConstraint) {
    notes.push(preserveUiConstraint);
  }
  return notes;
}

async function discoverPlanningCandidates(repoRoot: string): Promise<PlanningCandidate[]> {
  const entries = await fs.readdir(repoRoot, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory() && !isIgnoredDirectory(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  const files = entries
    .filter((entry) => entry.isFile() && !isIgnoredFile(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  const candidates: PlanningCandidate[] = directories.map((directory) => ({
    path: directory,
    source: 'top-level-dir',
  }));

  if (candidates.length < 3) {
    for (const directory of directories) {
      const childEntries = await fs.readdir(path.join(repoRoot, directory), {
        withFileTypes: true,
      });
      for (const child of childEntries) {
        if (!child.isDirectory() || isIgnoredDirectory(child.name)) {
          continue;
        }
        candidates.push({
          path: path.posix.join(directory, child.name),
          source: 'nested-dir',
        });
      }
    }
  }

  if (candidates.length < 3) {
    for (const file of files) {
      candidates.push({
        path: file,
        source: 'top-level-file',
      });
    }
  }

  if (candidates.length < 3) {
    for (const directory of directories) {
      const childEntries = await fs.readdir(path.join(repoRoot, directory), {
        withFileTypes: true,
      });
      for (const child of childEntries) {
        if (!child.isFile() || isIgnoredFile(child.name)) {
          continue;
        }
        candidates.push({
          path: path.posix.join(directory, child.name),
          source: 'nested-file',
        });
      }
    }
  }

  const seen = new Set<string>();
  const normalizedCandidates = candidates.filter((candidate) => {
    const normalized = normalizeOwnedPath(candidate.path);
    if (!normalized || seen.has(normalized)) {
      return false;
    }
    seen.add(normalized);
    candidate.path = normalized;
    return true;
  });

  const prunedCandidates: PlanningCandidate[] = [];
  for (const candidate of [...normalizedCandidates].sort(
    (left, right) => right.path.length - left.path.length,
  )) {
    if (
      prunedCandidates.some((keptCandidate) => pathsOverlap(candidate.path, keptCandidate.path))
    ) {
      continue;
    }
    prunedCandidates.push(candidate);
  }

  return prunedCandidates.sort((left, right) => left.path.localeCompare(right.path));
}

function assignCandidatesToBuckets(candidates: PlanningCandidate[]): PlannerBucket[] {
  const buckets: PlannerBucket[] = [
    { slot: 1, theme: 'runtime', ownedPaths: [] },
    { slot: 2, theme: 'shared', ownedPaths: [] },
    { slot: 3, theme: 'ui', ownedPaths: [] },
  ];

  const sortedCandidates = [...candidates].sort((left, right) => {
    const leftScore = Math.max(
      scoreCandidateForTheme(left.path, 'runtime'),
      scoreCandidateForTheme(left.path, 'shared'),
      scoreCandidateForTheme(left.path, 'ui'),
    );
    const rightScore = Math.max(
      scoreCandidateForTheme(right.path, 'runtime'),
      scoreCandidateForTheme(right.path, 'shared'),
      scoreCandidateForTheme(right.path, 'ui'),
    );
    if (leftScore !== rightScore) {
      return rightScore - leftScore;
    }
    return left.path.localeCompare(right.path);
  });

  for (const candidate of sortedCandidates) {
    let chosenBucket = buckets[0];
    let chosenScore = -1;

    for (const bucket of buckets) {
      const bucketScore = scoreCandidateForTheme(candidate.path, bucket.theme);
      const chosenPathCount = chosenBucket.ownedPaths.length;
      const bucketPathCount = bucket.ownedPaths.length;
      if (
        bucketScore > chosenScore ||
        (bucketScore === chosenScore && bucketPathCount < chosenPathCount) ||
        (bucketScore === chosenScore &&
          bucketPathCount === chosenPathCount &&
          bucket.slot < chosenBucket.slot)
      ) {
        chosenBucket = bucket;
        chosenScore = bucketScore;
      }
    }

    chosenBucket.ownedPaths.push(candidate.path);
  }

  for (const bucket of buckets) {
    if (bucket.ownedPaths.length > 0) {
      continue;
    }
    const donor = [...buckets]
      .filter((candidate) => candidate.ownedPaths.length > 1)
      .sort((left, right) => right.ownedPaths.length - left.ownedPaths.length)[0];
    if (!donor) {
      continue;
    }
    const movedPath = donor.ownedPaths.pop();
    if (movedPath) {
      bucket.ownedPaths.push(movedPath);
    }
  }

  return buckets;
}

function inferSharedConstraints(input: PlanWorkInput, buckets: PlannerBucket[]): string[] {
  const constraints = splitLines(input.extraConstraints);
  const mentionsUi =
    /(^|[^a-z])(ui|ux|design|layout|visual|style|styling|theme|frontend|webview|react|component)([^a-z]|$)/i.test(
      `${input.userPrompt}\n${constraints.join('\n')}`,
    );
  const hasUiBucket = buckets.some(
    (bucket) => bucket.theme === 'ui' && bucket.ownedPaths.length > 0,
  );

  if (!mentionsUi && hasUiBucket) {
    constraints.push(
      'Preserve existing UI behavior and visuals unless the request clearly requires UI changes.',
    );
  }

  constraints.push('Do not edit another worker’s owned repo paths.');
  return [...new Set(constraints)];
}

function buildLocalPlannerResult(
  input: PlanWorkInput,
  candidates: PlanningCandidate[],
): MasterPlannerResult {
  const buckets = assignCandidatesToBuckets(candidates);
  const sharedConstraints = inferSharedConstraints(input, buckets);
  const preserveUiConstraint = sharedConstraints.find((constraint) =>
    /preserve existing ui behavior and visuals/i.test(constraint),
  );

  const assignments: MasterPlannerAssignment[] = buckets.map((bucket) => ({
    slot: bucket.slot,
    title: getAssignmentTitle(bucket),
    goal: getAssignmentGoal(bucket, input.userPrompt),
    ownedPaths: bucket.ownedPaths,
    acceptanceCriteria: getAcceptanceCriteria(bucket, preserveUiConstraint),
    coordinationNotes: getCoordinationNotes(bucket, preserveUiConstraint),
    dependsOnSlots: [],
  }));

  return {
    planSummary: `Split the request into 3 isolated tracks across ${assignments
      .map((assignment) => summarizePaths(assignment.ownedPaths))
      .join('; ')}.`,
    sharedConstraints,
    assignments,
  };
}

export function validatePlannerResult(candidate: MasterPlannerResult): {
  result?: MasterPlannerResult;
  errors: string[];
} {
  const errors: string[] = [];
  const planSummary = candidate.planSummary?.trim() ?? '';
  if (!planSummary) {
    errors.push('planSummary must be non-empty');
  }

  const sharedConstraints = splitLines(candidate.sharedConstraints);
  const assignments = [...(candidate.assignments ?? [])]
    .map((assignment) => ({
      slot: assignment.slot,
      title: assignment.title?.trim() ?? '',
      goal: assignment.goal?.trim() ?? '',
      ownedPaths: splitLines(assignment.ownedPaths).map(normalizeOwnedPath).filter(Boolean),
      acceptanceCriteria: splitLines(assignment.acceptanceCriteria),
      coordinationNotes: splitLines(assignment.coordinationNotes),
      dependsOnSlots: [...new Set(assignment.dependsOnSlots ?? [])].sort((a, b) => a - b),
    }))
    .sort((a, b) => a.slot - b.slot);

  if (assignments.length !== 3) {
    errors.push('assignments must contain exactly 3 items');
  }

  const expectedSlots = [1, 2, 3];
  const actualSlots = assignments.map((assignment) => assignment.slot);
  if (
    actualSlots.length === 3 &&
    actualSlots.some((slot, index) => slot !== expectedSlots[index])
  ) {
    errors.push('assignments must cover slots 1, 2, and 3 exactly once');
  }

  for (const assignment of assignments) {
    if (!assignment.title) {
      errors.push(`slot ${assignment.slot}: title must be non-empty`);
    }
    if (!assignment.goal) {
      errors.push(`slot ${assignment.slot}: goal must be non-empty`);
    }
    if (assignment.ownedPaths.length === 0) {
      errors.push(
        `slot ${assignment.slot}: ownedPaths must contain at least one repo-relative path`,
      );
    }
    if (assignment.dependsOnSlots.includes(assignment.slot)) {
      errors.push(`slot ${assignment.slot}: dependsOnSlots cannot reference itself`);
    }
  }

  for (let index = 0; index < assignments.length; index += 1) {
    for (let nextIndex = index + 1; nextIndex < assignments.length; nextIndex += 1) {
      for (const left of assignments[index].ownedPaths) {
        for (const right of assignments[nextIndex].ownedPaths) {
          if (pathsOverlap(left, right)) {
            errors.push(
              `ownedPaths overlap between slot ${assignments[index].slot} (${left}) and slot ${assignments[nextIndex].slot} (${right})`,
            );
          }
        }
      }
    }
  }

  if (errors.length > 0) {
    return { errors };
  }

  return {
    result: {
      planSummary,
      sharedConstraints,
      assignments,
    },
    errors: [],
  };
}

export class MasterOrchestrator {
  async planWork(input: PlanWorkInput): Promise<MasterPlannerResult> {
    input.onProgress?.({
      message: 'Scanning repository structure for a local 3-worker split.',
      level: 'info',
      phaseLabel: 'Planning Split',
      phaseDetail: 'Building a deterministic split directly from the repository layout.',
    });

    const discoveredCandidates = input.repoAreaHints?.length
      ? splitLines(input.repoAreaHints).map((candidatePath) => ({
          path: normalizeOwnedPath(candidatePath),
          source: 'top-level-dir' as const,
        }))
      : await discoverPlanningCandidates(input.repoRoot);
    const candidates = discoveredCandidates.filter((candidate) => candidate.path);

    if (candidates.length < 3) {
      throw new Error(
        'Master planner could not find enough distinct project areas to create 3 non-overlapping workers.',
      );
    }

    input.onProgress?.({
      message: `Found ${candidates.length.toString()} candidate project areas. Assigning non-overlapping ownership.`,
      level: 'info',
      phaseLabel: 'Planning Split',
      phaseDetail: 'Turning repository areas into 3 isolated worker ownership buckets.',
    });

    const result = buildLocalPlannerResult(input, candidates);
    const validation = validatePlannerResult(result);
    if (!validation.result) {
      throw new Error(
        `Master planner produced an invalid local split: ${validation.errors.join('; ')}`,
      );
    }

    input.onProgress?.({
      message: 'Local planner produced a valid 3-worker split.',
      level: 'success',
      phaseLabel: 'Planning Split',
      phaseDetail: 'Planning finished locally. Worktree provisioning can start immediately.',
    });
    return validation.result;
  }
}
