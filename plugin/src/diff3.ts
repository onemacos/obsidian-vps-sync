/**
 * diff3.ts — line-level 3-way merge engine
 *
 * Algorithm:
 *   1. Diff base→ours  to find which line ranges we changed.
 *   2. Diff base→theirs to find which line ranges they changed.
 *   3. Walk both hunk lists together:
 *        • Non-overlapping hunks from one side → apply cleanly.
 *        • Overlapping / conflicting hunks → emit conflict markers.
 *
 * Fast-path short-circuits handle the common cases (identical content,
 * only one side changed) without running the O(m*n) LCS.
 */

const MERGEABLE_EXTS = new Set([
  '.md', '.txt', '.canvas', '.json', '.yaml', '.yml', '.csv',
  '.html', '.htm', '.xml', '.js', '.ts', '.jsx', '.tsx',
  '.css', '.scss', '.less', '.sh', '.bash', '.zsh', '.py',
  '.rb', '.go', '.rs', '.java', '.c', '.cpp', '.h',
  '.toml', '.ini', '.env', '.log', '.svg', '.mjs', '.cjs',
  '.mdx', '.org', '.wiki', '.excalidraw',
]);

export function isMergeableFile(filePath: string): boolean {
  const dot = filePath.lastIndexOf('.');
  if (dot === -1) return false;
  return MERGEABLE_EXTS.has(filePath.slice(dot).toLowerCase());
}

// ── LCS / Diff ────────────────────────────────────────────────────────────────

/** A single changed hunk relative to base. */
interface Hunk {
  /** First base line index included in the change (inclusive). */
  baseStart: number;
  /** One past the last base line included (exclusive). */
  baseEnd: number;
  /** Replacement lines from the modified side. */
  lines: string[];
}

function lcs(a: string[], b: string[]): number[][] {
  const m = a.length, n = b.length;
  // Flatten 2-D DP into a 1-D array for speed.
  const dp = new Uint32Array((m + 1) * (n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i * (n + 1) + j] =
        a[i] === b[j]
          ? dp[(i + 1) * (n + 1) + (j + 1)] + 1
          : Math.max(dp[(i + 1) * (n + 1) + j], dp[i * (n + 1) + (j + 1)]);
    }
  }

  // Backtrack to build a list of matching pairs [aIdx, bIdx].
  const matches: number[][] = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      matches.push([i, j]);
      i++; j++;
    } else if (dp[(i + 1) * (n + 1) + j] >= dp[i * (n + 1) + (j + 1)]) {
      i++;
    } else {
      j++;
    }
  }
  return matches;
}

/**
 * Compute the hunks that turn `base` into `modified`.
 * Each hunk describes a range of base lines that was replaced with new lines.
 */
function diffHunks(base: string[], modified: string[]): Hunk[] {
  const matches = lcs(base, modified);

  const hunks: Hunk[] = [];
  let bi = 0, mi = 0;
  let hunkBase = -1, hunkMod = -1;
  const pendingLines: string[] = [];

  const flush = () => {
    if (hunkBase !== -1) {
      hunks.push({ baseStart: hunkBase, baseEnd: bi, lines: [...pendingLines] });
      hunkBase = -1; hunkMod = -1; pendingLines.length = 0;
    }
  };

  for (const [matchBi, matchMi] of matches) {
    // Lines before this match on either side → hunk
    if (matchBi > bi || matchMi > mi) {
      if (hunkBase === -1) { hunkBase = bi; hunkMod = mi; }
      // Collect deleted base lines (they don't appear in the hunk's lines).
      // The hunk.lines will contain the modified side's replacements.
      for (let k = mi; k < matchMi; k++) pendingLines.push(modified[k]);
      // If only base lines were deleted (no new mod lines), lines stays empty.
      // Advance base pointer past deleted base lines.
      bi = matchBi;
      if (matchMi > hunkMod + pendingLines.length - (matchMi - mi)) {
        // noop — tracking done above
      }
    }
    flush();
    bi = matchBi + 1;
    mi = matchMi + 1;
  }

  // Trailing changes after the last match
  if (bi < base.length || mi < modified.length) {
    if (hunkBase === -1) { hunkBase = bi; hunkMod = mi; }
    for (let k = mi; k < modified.length; k++) pendingLines.push(modified[k]);
    bi = base.length;
    flush();
  }

  return hunks;
}

// ── 3-way merge ───────────────────────────────────────────────────────────────

export interface MergeResult {
  /** The merged text. May contain conflict markers if conflicts > 0. */
  merged: string;
  /** Number of conflict regions in the output. 0 = clean merge. */
  conflicts: number;
}

const MAX_LINES = 5000;

/**
 * Attempt a 3-way line-level merge.
 *
 * Returns null if the file is too large to merge safely (> MAX_LINES each side).
 * Returns a MergeResult with conflicts=0 for a clean merge,
 * or conflicts>0 with standard conflict markers embedded.
 */
export function merge3(base: string, ours: string, theirs: string): MergeResult | null {
  // ── Fast paths ────────────────────────────────────────────────────────────
  if (ours === theirs)  return { merged: ours,   conflicts: 0 };
  if (base === ours)    return { merged: theirs,  conflicts: 0 };
  if (base === theirs)  return { merged: ours,    conflicts: 0 };

  const baseLines   = base.split('\n');
  const oursLines   = ours.split('\n');
  const theirsLines = theirs.split('\n');

  if (
    baseLines.length   > MAX_LINES ||
    oursLines.length   > MAX_LINES ||
    theirsLines.length > MAX_LINES
  ) {
    return null; // too large — fall back to conflict copy
  }

  const ourHunks   = diffHunks(baseLines, oursLines);
  const theirHunks = diffHunks(baseLines, theirsLines);

  // ── Walk both hunk lists ──────────────────────────────────────────────────

  const output: string[] = [];
  let conflicts = 0;
  let basePos = 0;       // next unconsumed base line index
  let oi = 0, ti = 0;   // hunk pointers

  const emitBase = (end: number) => {
    for (let i = basePos; i < end; i++) output.push(baseLines[i]);
    basePos = end;
  };

  while (oi < ourHunks.length || ti < theirHunks.length) {
    const oh = oi < ourHunks.length   ? ourHunks[oi]   : null;
    const th = ti < theirHunks.length ? theirHunks[ti] : null;

    // Emit unchanged base lines up to the next hunk
    const nextStart = Math.min(oh?.baseStart ?? Infinity, th?.baseStart ?? Infinity);
    if (nextStart > basePos) emitBase(nextStart);

    if (oh && (!th || oh.baseEnd <= th.baseStart)) {
      // Only our side changed (or our hunk ends before theirs begins)
      output.push(...oh.lines);
      basePos = oh.baseEnd;
      oi++;
    } else if (th && (!oh || th.baseEnd <= oh.baseStart)) {
      // Only their side changed
      output.push(...th.lines);
      basePos = th.baseEnd;
      ti++;
    } else if (oh && th) {
      // Overlapping hunks → conflict region
      // Collect all overlapping hunks on each side
      const conflictBaseStart = Math.min(oh.baseStart, th.baseStart);
      let conflictBaseEnd     = Math.max(oh.baseEnd,   th.baseEnd);

      const ourLines:   string[] = [...oh.lines];
      const theirLines: string[] = [...th.lines];
      oi++; ti++;

      // Absorb any further hunks that overlap with the conflict region
      while (
        oi < ourHunks.length &&
        ourHunks[oi].baseStart < conflictBaseEnd
      ) {
        conflictBaseEnd = Math.max(conflictBaseEnd, ourHunks[oi].baseEnd);
        ourLines.push(...ourHunks[oi].lines);
        oi++;
      }
      while (
        ti < theirHunks.length &&
        theirHunks[ti].baseStart < conflictBaseEnd
      ) {
        conflictBaseEnd = Math.max(conflictBaseEnd, theirHunks[ti].baseEnd);
        theirLines.push(...theirHunks[ti].lines);
        ti++;
      }

      // Check if both sides made the *same* change → clean
      if (ourLines.join('\n') === theirLines.join('\n')) {
        output.push(...ourLines);
      } else {
        output.push(
          '<<<<<<< local',
          ...ourLines,
          '=======',
          ...theirLines,
          '>>>>>>> remote',
        );
        conflicts++;
      }
      basePos = conflictBaseEnd;
    }
  }

  // Emit remaining base lines
  emitBase(baseLines.length);

  return { merged: output.join('\n'), conflicts };
}
