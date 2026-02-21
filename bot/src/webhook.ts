// webhook.ts — GitHub webhook server for Preflex PR reviews
//
// Replaces the GitHub Actions workflow. Connects to locally-running
// Elastic MCP and Preflex MCP servers instead of spinning them up per-PR.

import * as http from "node:http";
import * as crypto from "node:crypto";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAppAuth } from "@octokit/auth-app";
import { runReview } from "./review.js";

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? "";
const APP_ID = process.env.GITHUB_APP_ID ?? "";
const PRIVATE_KEY = process.env.GITHUB_PRIVATE_KEY ?? "";

function verifySignature(payload: Buffer, signature: string): boolean {
  const expected = "sha256=" + crypto.createHmac("sha256", WEBHOOK_SECRET).update(payload).digest("hex");
  if (signature.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

async function mintInstallationToken(installationId: number): Promise<string> {
  const auth = createAppAuth({ appId: APP_ID, privateKey: PRIVATE_KEY });
  const { token } = await auth({ type: "installation", installationId });
  return token;
}

async function handlePullRequest(payload: {
  action: string;
  installation?: { id: number };
  pull_request: { number: number; head: { ref: string } };
  repository: { owner: { login: string }; name: string; clone_url: string };
}): Promise<void> {
  const { action, installation, pull_request: pr, repository: repo } = payload;

  if (action !== "opened" && action !== "synchronize") return;
  if (!installation) {
    console.error("No installation in payload — is the webhook from a GitHub App?");
    return;
  }

  const owner = repo.owner.login;
  const repoName = repo.name;
  const prNumber = pr.number;
  const headRef = pr.head.ref;

  console.log(`PR #${prNumber} ${action} on ${owner}/${repoName} (branch: ${headRef})`);

  const token = await mintInstallationToken(installation.id);

  // Clone to a temp dir so the fix agent can read/write files
  const tmpDir = mkdtempSync(join(tmpdir(), "preflex-"));
  try {
    const cloneUrl = `https://x-access-token:${token}@github.com/${owner}/${repoName}.git`;
    execSync(`git clone --depth 1 --branch ${headRef} ${cloneUrl} ${tmpDir}`, {
      stdio: "pipe",
    });

    // Set GH_TOKEN so Agent SDK subprocess can push via `gh`
    process.env.GH_TOKEN = token;

    await runReview({
      owner,
      repo: repoName,
      prNumber,
      token,
      mcpBaseUrl: process.env.MCP_BASE_URL,
      elasticMcpUrl: process.env.ELASTIC_MCP_URL,
      repoRoot: tmpDir,
    });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

const server = http.createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/webhook") {
    res.writeHead(404).end("Not found");
    return;
  }

  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const signature = req.headers["x-hub-signature-256"] as string | undefined;

    if (WEBHOOK_SECRET && (!signature || !verifySignature(body, signature))) {
      res.writeHead(401).end("Bad signature");
      return;
    }

    const event = req.headers["x-github-event"] as string;
    const payload = JSON.parse(body.toString());

    // Respond immediately — process in background
    res.writeHead(200).end("ok");

    if (event === "pull_request") {
      handlePullRequest(payload).catch((err) =>
        console.error(`Review failed for PR #${payload.pull_request?.number}:`, err),
      );
    }
  });
});

server.listen(PORT, () => {
  console.log(`Preflex webhook server listening on :${PORT}`);
});
