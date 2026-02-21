// github.ts — GitHub API helpers for diff fetching, comment posting, and PR creation

import { Octokit } from "@octokit/rest";

export interface PrContext {
  owner: string;
  repo: string;
  prNumber: number;
}

export function createOctokit(token?: string): Octokit {
  return new Octokit({ auth: token ?? process.env.GITHUB_TOKEN });
}

/**
 * Fetch the diff for a pull request, filtered to .ts/.js files only.
 */
export async function getPrDiff(
  octokit: Octokit,
  ctx: PrContext,
): Promise<string> {
  const { data } = await octokit.pulls.get({
    owner: ctx.owner,
    repo: ctx.repo,
    pull_number: ctx.prNumber,
    mediaType: { format: "diff" },
  });

  // data is the raw diff string when format=diff
  const fullDiff = data as unknown as string;

  // Filter to only .ts and .js file diffs
  return filterDiffToTsJs(fullDiff);
}

/**
 * Filter a unified diff to only include .ts and .js files.
 */
export function filterDiffToTsJs(diff: string): string {
  const lines = diff.split("\n");
  const filtered: string[] = [];
  let include = false;

  for (const line of lines) {
    if (line.startsWith("diff --git")) {
      // Check if this file is .ts or .js
      include = /\.(ts|js)$/.test(line) && !line.includes(".d.ts");
      if (include) filtered.push(line);
    } else if (include) {
      filtered.push(line);
    }
  }

  return filtered.join("\n");
}

/** A single added line from a parsed diff. */
export interface DiffLine {
  file: string;
  line: number;
  content: string;
}

/**
 * Parse a unified diff into structured added lines with file paths and line numbers.
 * Only includes added (+) lines — these are the ones we can comment on.
 */
export function parseDiffLines(diff: string): DiffLine[] {
  const lines = diff.split("\n");
  const result: DiffLine[] = [];
  let currentFile = "";
  let newLineNum = 0;

  for (const line of lines) {
    // File header: diff --git a/src/routes/orders.ts b/src/routes/orders.ts
    if (line.startsWith("diff --git")) {
      const match = line.match(/b\/(.+)$/);
      if (match) currentFile = match[1];
      continue;
    }

    // Hunk header: @@ -68,4 +70,40 @@
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      newLineNum = parseInt(hunkMatch[1], 10);
      continue;
    }

    // Skip file metadata lines
    if (
      line.startsWith("---") ||
      line.startsWith("+++") ||
      line.startsWith("index ") ||
      line.startsWith("new file") ||
      line.startsWith("old mode") ||
      line.startsWith("new mode")
    ) {
      continue;
    }

    // Added line
    if (line.startsWith("+")) {
      result.push({
        file: currentFile,
        line: newLineNum,
        content: line.slice(1), // strip the leading +
      });
      newLineNum++;
      continue;
    }

    // Context line (unchanged)
    if (line.startsWith(" ") || line === "") {
      newLineNum++;
      continue;
    }

    // Deleted line — doesn't increment newLineNum
    if (line.startsWith("-")) {
      continue;
    }
  }

  return result;
}

/**
 * Fuzzy-match a code snippet to the best matching line in the diff.
 *
 * Strategy:
 *   1. Exact substring match (after whitespace normalization)
 *   2. Best overlap score (longest common substring ratio)
 *
 * Returns the line number of the best match, or null if no match above threshold.
 */
export function matchCodeToLine(
  diffLines: DiffLine[],
  file: string,
  code: string,
): number | null {
  // Filter to only lines in the target file
  const fileLines = diffLines.filter((dl) => dl.file === file);
  if (fileLines.length === 0) return null;

  const normalizedCode = normalize(code);

  // 1. Try exact substring match — check if normalized code appears in any line
  for (const dl of fileLines) {
    if (normalize(dl.content).includes(normalizedCode)) {
      return dl.line;
    }
  }

  // 2. Try matching against multi-line windows (code might span several lines)
  //    Build sliding windows of 1-5 consecutive lines
  for (let windowSize = 2; windowSize <= 5; windowSize++) {
    for (let i = 0; i <= fileLines.length - windowSize; i++) {
      const window = fileLines
        .slice(i, i + windowSize)
        .map((dl) => dl.content)
        .join(" ");
      if (normalize(window).includes(normalizedCode)) {
        // Return the last line of the window (where the key SQL clause likely is)
        return fileLines[i + windowSize - 1].line;
      }
    }
  }

  // 3. Fallback: find the line with the best token overlap
  let bestScore = 0;
  let bestLine: number | null = null;
  const codeTokens = new Set(normalizedCode.split(/\s+/).filter(Boolean));

  for (const dl of fileLines) {
    const lineTokens = normalize(dl.content).split(/\s+/).filter(Boolean);
    const overlap = lineTokens.filter((t) => codeTokens.has(t)).length;
    const score = overlap / Math.max(codeTokens.size, 1);

    if (score > bestScore && score >= 0.5) {
      bestScore = score;
      bestLine = dl.line;
    }
  }

  return bestLine;
}

/** Normalize whitespace for fuzzy comparison. */
function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Post a comment on a PR.
 */
export async function postComment(
  octokit: Octokit,
  ctx: PrContext,
  body: string,
): Promise<number> {
  const { data } = await octokit.issues.createComment({
    owner: ctx.owner,
    repo: ctx.repo,
    issue_number: ctx.prNumber,
    body,
  });
  return data.id;
}

/**
 * Post a code review with inline comments on specific diff lines.
 */
export async function postReview(
  octokit: Octokit,
  ctx: PrContext,
  comments: Array<{ path: string; line: number; body: string }>,
): Promise<number> {
  const { data: pr } = await octokit.pulls.get({
    owner: ctx.owner,
    repo: ctx.repo,
    pull_number: ctx.prNumber,
  });

  const { data } = await octokit.pulls.createReview({
    owner: ctx.owner,
    repo: ctx.repo,
    pull_number: ctx.prNumber,
    commit_id: pr.head.sha,
    event: "COMMENT",
    comments: comments.map((c) => ({
      path: c.path,
      line: c.line,
      side: "RIGHT" as const,
      body: c.body,
    })),
  });
  return data.id;
}

/**
 * Create a new branch, commit changes, and open a PR.
 */
export async function createFixPr(
  octokit: Octokit,
  ctx: PrContext & { baseBranch: string },
  files: Array<{ path: string; content: string }>,
): Promise<string> {
  const branchName = `preflex/fix-${ctx.prNumber}`;

  // Get the base branch SHA
  const { data: ref } = await octokit.git.getRef({
    owner: ctx.owner,
    repo: ctx.repo,
    ref: `heads/${ctx.baseBranch}`,
  });
  const baseSha = ref.object.sha;

  // Create the branch
  await octokit.git.createRef({
    owner: ctx.owner,
    repo: ctx.repo,
    ref: `refs/heads/${branchName}`,
    sha: baseSha,
  });

  // Get the base tree
  const { data: baseCommit } = await octokit.git.getCommit({
    owner: ctx.owner,
    repo: ctx.repo,
    commit_sha: baseSha,
  });

  // Create blobs for each file
  const treeItems = await Promise.all(
    files.map(async (f) => {
      const { data: blob } = await octokit.git.createBlob({
        owner: ctx.owner,
        repo: ctx.repo,
        content: Buffer.from(f.content).toString("base64"),
        encoding: "base64",
      });
      return {
        path: f.path,
        mode: "100644" as const,
        type: "blob" as const,
        sha: blob.sha,
      };
    }),
  );

  // Create tree
  const { data: tree } = await octokit.git.createTree({
    owner: ctx.owner,
    repo: ctx.repo,
    base_tree: baseCommit.tree.sha,
    tree: treeItems,
  });

  // Create commit
  const { data: commit } = await octokit.git.createCommit({
    owner: ctx.owner,
    repo: ctx.repo,
    message:
      "refactor: migrate search queries from Postgres to Elasticsearch\n\nRewrites ILIKE/LIKE/pg_trgm queries to use ES match/multi_match.\nPreserves all Postgres write operations.\n\nGenerated by Preflex Fix Agent.",
    tree: tree.sha,
    parents: [baseSha],
  });

  // Update branch ref
  await octokit.git.updateRef({
    owner: ctx.owner,
    repo: ctx.repo,
    ref: `heads/${branchName}`,
    sha: commit.sha,
  });

  // Create PR
  const { data: pr } = await octokit.pulls.create({
    owner: ctx.owner,
    repo: ctx.repo,
    title: "refactor: migrate search queries to Elasticsearch",
    body: [
      "## Summary",
      "",
      "Rewrites Postgres search/analytics queries to use Elasticsearch, as identified by Preflex.",
      "",
      "- Full-text search (`ILIKE '%term%'`) → ES `match` / `multi_match`",
      "- Fuzzy matching (`pg_trgm similarity`) → ES `match` with `fuzziness`",
      "- Log search (`LIKE` + timestamp range) → ES `bool` + `match` + `range`",
      "- Complex aggregations (`GROUP BY` multi-dim) → ES `terms` + `date_histogram`",
      "",
      "All Postgres write operations (INSERT/UPDATE/DELETE) are preserved.",
      "Updates `pgsync.yml` to include any new fields referenced by ES queries.",
      "",
      `Fixes findings from PR #${ctx.prNumber}.`,
      "",
      "---",
      "_Generated by [Preflex](https://github.com/anyuan-chen/preflex) Fix Agent_",
    ].join("\n"),
    head: branchName,
    base: ctx.baseBranch,
  });

  return pr.html_url;
}

/**
 * Get all Preflex comments on a PR, concatenated.
 * Each finding is posted as a separate comment — this collects them all.
 */
export async function getCommentBody(
  octokit: Octokit,
  ctx: PrContext,
  marker: string,
): Promise<string | null> {
  const { data: comments } = await octokit.issues.listComments({
    owner: ctx.owner,
    repo: ctx.repo,
    issue_number: ctx.prNumber,
  });

  const matching = comments
    .filter((c) => c.body?.includes(marker))
    .map((c) => c.body!);

  if (matching.length === 0) return null;
  return matching.join("\n\n---\n\n");
}

/**
 * Get the head branch name of a PR.
 */
export async function getPrBranch(
  octokit: Octokit,
  ctx: PrContext,
): Promise<string> {
  const { data: pr } = await octokit.pulls.get({
    owner: ctx.owner,
    repo: ctx.repo,
    pull_number: ctx.prNumber,
  });
  return pr.head.ref;
}
