// review.ts — PR reviewer: fetch diff → analyze with ES context → fix → post inline comments
//
// Pipeline:
//   1. Agent SDK analyzes diff with Elastic MCP tools for cluster context
//   2. Returns { file, code, comment } — fuzzy-matched to exact line numbers
//   3. Fix agent creates a PR with ES-rewritten queries
//   4. Post inline review comments linking to the fix PR

import { query } from "@anthropic-ai/claude-agent-sdk";
import { REVIEW_PROMPT } from "./prompts.js";
import {
  createOctokit,
  getPrDiff,
  getPrBranch,
  parseDiffLines,
  matchCodeToLine,
  postReview,
  type PrContext,
  type DiffLine,
} from "./github.js";
import { runFixAgent } from "./fix-agent.js";

/** What the LLM returns — code snippet instead of line number. */
export interface RawFinding {
  file: string;
  code: string;
  comment: string;
}

/** After matching — has a resolved line number for the review API. */
export interface Finding {
  file: string;
  line: number;
  comment: string;
}

/**
 * Analyze a diff with Claude using the Agent SDK.
 * The agent has access to the Elastic MCP server to inspect indices, mappings,
 * and field types — making reviews more accurate.
 */
export async function analyzeDiff(
  diff: string,
  elasticMcpUrl: string,
): Promise<RawFinding[]> {
  let resultText = "";

  for await (const message of query({
    prompt: `Analyze this PR diff for database queries that should be migrated to Elasticsearch:\n\n\`\`\`diff\n${diff}\n\`\`\`\n\nUse the elasticsearch MCP tools (list_indices, get_mappings) to check what ES indices and field types are available before making recommendations. This helps you write more accurate comments referencing actual field types and index names.`,
    options: {
      systemPrompt: REVIEW_PROMPT,
      allowedTools: [
        "mcp__elasticsearch__*",
      ],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      maxTurns: 5,
      model: "claude-sonnet-4-5-20250929",
      mcpServers: {
        elasticsearch: {
          type: "http",
          url: `${elasticMcpUrl}/mcp`,
        },
      },
    },
  })) {
    if (message.type === "result" && message.subtype === "success") {
      resultText = message.result;
    }
  }

  if (!resultText) return [];

  try {
    return JSON.parse(resultText) as RawFinding[];
  } catch {
    const match = resultText.match(/\[[\s\S]*\]/);
    if (match) {
      return JSON.parse(match[0]) as RawFinding[];
    }
    return [];
  }
}

/**
 * Resolve raw findings (code snippets) to exact line numbers by matching
 * against the parsed diff. Drops findings that can't be matched.
 */
export function resolveFindings(
  rawFindings: RawFinding[],
  diffLines: DiffLine[],
): Finding[] {
  const resolved: Finding[] = [];

  for (const raw of rawFindings) {
    const line = matchCodeToLine(diffLines, raw.file, raw.code);
    if (line !== null) {
      resolved.push({ file: raw.file, line, comment: raw.comment });
    } else {
      console.warn(
        `Could not match code snippet to diff line: ${raw.file} — "${raw.code.slice(0, 60)}..."`,
      );
    }
  }

  return resolved;
}

/**
 * Format a single finding as an inline review comment.
 */
export function formatFindingComment(finding: Finding, ctx: PrContext, fixPrUrl?: string): string {
  const lines = [finding.comment];

  if (fixPrUrl) {
    lines.push("", `[**View fix \u2192**](${fixPrUrl})`);
  }

  return lines.join("\n");
}

/**
 * Format resolved findings into a text summary for the fix agent.
 */
export function formatFindingsForAgent(findings: Finding[]): string {
  return findings
    .map(
      (f, i) =>
        `### ${i + 1}. ${f.file}:${f.line}\n${f.comment}`,
    )
    .join("\n\n");
}

/** Options for running a review programmatically (webhook or CLI). */
export interface ReviewOptions {
  owner: string;
  repo: string;
  prNumber: number;
  token: string;
  mcpBaseUrl?: string;
  elasticMcpUrl?: string;
  repoRoot?: string;
}

/**
 * Run the full review pipeline: fetch diff → analyze → fix → post comments.
 */
export async function runReview(opts: ReviewOptions): Promise<void> {
  const {
    owner,
    repo,
    prNumber,
    token,
    mcpBaseUrl = "http://127.0.0.1:3100",
    elasticMcpUrl = "http://127.0.0.1:8080",
    repoRoot = process.cwd(),
  } = opts;

  const ctx: PrContext = { owner, repo, prNumber };
  const octokit = createOctokit(token);

  console.log(`Reviewing PR #${prNumber} on ${owner}/${repo}...`);

  // 1. Get the diff (filtered to .ts/.js)
  const diff = await getPrDiff(octokit, ctx);

  if (!diff.trim()) {
    console.log("No .ts/.js changes in this PR — skipping review.");
    return;
  }

  console.log(`Diff size: ${diff.length} chars`);

  // 2. Parse diff into structured lines for matching
  const diffLines = parseDiffLines(diff);

  // 3. Analyze with Agent SDK + Elastic MCP (returns code snippets, not line numbers)
  const rawFindings = await analyzeDiff(diff, elasticMcpUrl);

  if (rawFindings.length === 0) {
    console.log("No findings — skipping comment.");
    return;
  }

  // 4. Resolve code snippets to exact line numbers
  const findings = resolveFindings(rawFindings, diffLines);

  if (findings.length === 0) {
    console.log("Findings returned but none matched diff lines — skipping.");
    return;
  }

  console.log(`Matched ${findings.length}/${rawFindings.length} findings to diff lines.`);

  // 5. Run fix agent → create fix PR
  let fixPrUrl: string | undefined;
  try {
    console.log("Running fix agent...");
    const reviewSummary = formatFindingsForAgent(findings);
    const baseBranch = await getPrBranch(octokit, ctx);
    const result = await runFixAgent({
      mcpBaseUrl,
      elasticMcpUrl,
      repoRoot,
      reviewSummary,
      prNumber,
      baseBranch,
    });

    if (result.fixPrUrl) {
      fixPrUrl = result.fixPrUrl;
      console.log(`Fix PR created: ${fixPrUrl}`);
    } else {
      console.log("Fix agent did not create a PR.");
    }
  } catch (err) {
    console.error("Fix agent failed (review will still be posted):", err);
  }

  // 6. Post inline review comments
  const reviewComments = findings.map((finding) => ({
    path: finding.file,
    line: finding.line,
    body: formatFindingComment(finding, ctx, fixPrUrl),
  }));

  await postReview(octokit, ctx, reviewComments);

  console.log(`Posted review with ${findings.length} inline comments.`);
}

/**
 * CLI entry point — reads env vars and calls runReview().
 */
async function main(): Promise<void> {
  const owner = process.env.GITHUB_REPOSITORY?.split("/")[0];
  const repo = process.env.GITHUB_REPOSITORY?.split("/")[1];
  const prNumber = parseInt(process.env.PR_NUMBER ?? "", 10);
  const token = process.env.GITHUB_TOKEN ?? "";

  if (!owner || !repo || !prNumber) {
    console.error("Missing GITHUB_REPOSITORY or PR_NUMBER");
    process.exit(1);
  }

  await runReview({
    owner,
    repo,
    prNumber,
    token,
    mcpBaseUrl: process.env.MCP_BASE_URL,
    elasticMcpUrl: process.env.ELASTIC_MCP_URL,
    repoRoot: process.env.GITHUB_WORKSPACE ?? process.cwd(),
  });
}

// Run if executed directly
const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("/review.js");

if (isMain) {
  main().catch((err) => {
    console.error("Review failed:", err);
    process.exit(1);
  });
}
