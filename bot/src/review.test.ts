// review.test.ts — Tests for the PR reviewer

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  formatFindingComment,
  formatFindingsForAgent,
  resolveFindings,
  type Finding,
  type RawFinding,
} from "./review.js";
import {
  filterDiffToTsJs,
  parseDiffLines,
  matchCodeToLine,
} from "./github.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "test", "fixtures");

describe("filterDiffToTsJs", () => {
  it("filters diff to only .ts and .js files", () => {
    const diff = [
      "diff --git a/src/routes/orders.ts b/src/routes/orders.ts",
      "+++ b/src/routes/orders.ts",
      "+const x = 1;",
      "diff --git a/README.md b/README.md",
      "+++ b/README.md",
      "+# Hello",
      "diff --git a/src/utils.js b/src/utils.js",
      "+++ b/src/utils.js",
      "+module.exports = {};",
    ].join("\n");

    const result = filterDiffToTsJs(diff);
    expect(result).toContain("orders.ts");
    expect(result).toContain("utils.js");
    expect(result).not.toContain("README.md");
  });

  it("excludes .d.ts files", () => {
    const diff = [
      "diff --git a/types.d.ts b/types.d.ts",
      "+++ b/types.d.ts",
      "+export type Foo = string;",
    ].join("\n");

    const result = filterDiffToTsJs(diff);
    expect(result).toBe("");
  });
});

describe("parseDiffLines", () => {
  it("parses hunk headers and tracks line numbers for added lines", () => {
    const diff = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "index abc..def 100644",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -10,3 +10,5 @@ some context",
      " unchanged line",
      "+added line one",
      "+added line two",
      " another unchanged",
      "-removed line",
    ].join("\n");

    const lines = parseDiffLines(diff);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({ file: "src/foo.ts", line: 11, content: "added line one" });
    expect(lines[1]).toEqual({ file: "src/foo.ts", line: 12, content: "added line two" });
  });

  it("handles multiple files", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "@@ -1,1 +1,2 @@",
      " existing",
      "+new in a",
      "diff --git a/b.ts b/b.ts",
      "@@ -1,1 +1,2 @@",
      " existing",
      "+new in b",
    ].join("\n");

    const lines = parseDiffLines(diff);
    expect(lines).toHaveLength(2);
    expect(lines[0].file).toBe("a.ts");
    expect(lines[0].content).toBe("new in a");
    expect(lines[1].file).toBe("b.ts");
    expect(lines[1].content).toBe("new in b");
  });

  it("parses the sample diff fixture", () => {
    const diff = readFileSync(join(fixturesDir, "sample-diff.txt"), "utf-8");
    const filtered = filterDiffToTsJs(diff);
    const lines = parseDiffLines(filtered);

    expect(lines.length).toBeGreaterThan(0);

    // Every parsed line should have a valid file and positive line number
    for (const dl of lines) {
      expect(dl.file).toBeTruthy();
      expect(dl.line).toBeGreaterThan(0);
    }

    // Should include lines from our key files
    const files = new Set(lines.map((l) => l.file));
    expect(files.has("src/routes/orders.ts")).toBe(true);
    expect(files.has("src/routes/service-logs.ts")).toBe(true);
    expect(files.has("src/routes/inventory.ts")).toBe(true);
    expect(files.has("src/routes/dashboard.ts")).toBe(true);
  });
});

describe("matchCodeToLine", () => {
  const diffLines = [
    { file: "src/foo.ts", line: 10, content: "  const x = 1;" },
    { file: "src/foo.ts", line: 11, content: '  WHERE description ILIKE $1 OR key_type ILIKE $1' },
    { file: "src/foo.ts", line: 12, content: "  ORDER BY created_at DESC" },
    { file: "src/bar.ts", line: 5, content: "  GROUP BY service_type, technician" },
  ];

  it("matches exact substring (whitespace-normalized)", () => {
    const line = matchCodeToLine(diffLines, "src/foo.ts", "WHERE description ILIKE $1 OR key_type ILIKE $1");
    expect(line).toBe(11);
  });

  it("matches case-insensitively", () => {
    const line = matchCodeToLine(diffLines, "src/foo.ts", "where description ilike $1 or key_type ilike $1");
    expect(line).toBe(11);
  });

  it("returns null for wrong file", () => {
    const line = matchCodeToLine(diffLines, "src/baz.ts", "WHERE description ILIKE $1");
    expect(line).toBeNull();
  });

  it("returns null when no match above threshold", () => {
    const line = matchCodeToLine(diffLines, "src/foo.ts", "SELECT * FROM completely_different_table");
    expect(line).toBeNull();
  });

  it("uses token overlap for partial matches", () => {
    // "GROUP BY service_type, technician" shares tokens with the bar.ts line
    const line = matchCodeToLine(diffLines, "src/bar.ts", "GROUP BY service_type, technician, DATE_TRUNC('day', timestamp)");
    expect(line).toBe(5);
  });
});

describe("resolveFindings", () => {
  it("resolves raw findings with code to line numbers", () => {
    const diffLines = [
      { file: "src/routes/orders.ts", line: 84, content: '     WHERE description ILIKE $1 OR key_type ILIKE $1' },
      { file: "src/routes/orders.ts", line: 85, content: "     ORDER BY order_date DESC" },
    ];

    const raw: RawFinding[] = [
      {
        file: "src/routes/orders.ts",
        code: "WHERE description ILIKE $1 OR key_type ILIKE $1",
        comment: "This is a bad pattern.",
      },
    ];

    const resolved = resolveFindings(raw, diffLines);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].file).toBe("src/routes/orders.ts");
    expect(resolved[0].line).toBe(84);
    expect(resolved[0].comment).toBe("This is a bad pattern.");
  });

  it("drops findings that cannot be matched", () => {
    const diffLines = [
      { file: "src/routes/orders.ts", line: 84, content: "something unrelated" },
    ];

    const raw: RawFinding[] = [
      {
        file: "src/routes/orders.ts",
        code: "WHERE description ILIKE $1",
        comment: "Bad pattern.",
      },
    ];

    const resolved = resolveFindings(raw, diffLines);
    expect(resolved).toHaveLength(0);
  });
});

describe("resolveFindings against sample diff", () => {
  it("resolves all mock findings to line numbers in the sample diff", () => {
    const diff = readFileSync(join(fixturesDir, "sample-diff.txt"), "utf-8");
    const filtered = filterDiffToTsJs(diff);
    const diffLines = parseDiffLines(filtered);

    const raw: RawFinding[] = JSON.parse(
      readFileSync(join(fixturesDir, "mock-review-response.json"), "utf-8"),
    );

    const resolved = resolveFindings(raw, diffLines);

    // All 6 findings should resolve
    expect(resolved.length).toBe(6);

    // Each should have a valid line number
    for (const f of resolved) {
      expect(f.line).toBeGreaterThan(0);
      expect(f.comment).toBeTruthy();
    }

    // Verify expected files are covered
    const files = resolved.map((f) => f.file);
    expect(files).toContain("src/routes/orders.ts");
    expect(files).toContain("src/routes/service-logs.ts");
    expect(files).toContain("src/routes/inventory.ts");
    expect(files).toContain("src/routes/dashboard.ts");
  });
});

describe("formatFindingComment", () => {
  const ctx = { owner: "anyuan-chen", repo: "clees-keys", prNumber: 1 };

  it("includes fix PR link when provided", () => {
    const finding: Finding = {
      file: "src/routes/orders.ts",
      line: 84,
      comment: "This ILIKE search is going to sequential scan the entire orders table.",
    };

    const comment = formatFindingComment(finding, ctx, "https://github.com/anyuan-chen/clees-keys/pull/2");

    expect(comment).toContain("sequential scan");
    expect(comment).toContain("View fix");
    expect(comment).toContain("https://github.com/anyuan-chen/clees-keys/pull/2");
  });

  it("omits fix link when no fix PR URL provided", () => {
    const finding: Finding = {
      file: "src/routes/orders.ts",
      line: 84,
      comment: "This ILIKE search is going to sequential scan the entire orders table.",
    };

    const comment = formatFindingComment(finding, ctx);

    expect(comment).toContain("sequential scan");
    expect(comment).not.toContain("View fix");
  });

  it("does not include file:line reference (it's inline)", () => {
    const finding: Finding = {
      file: "src/routes/orders.ts",
      line: 84,
      comment: "Something bad here.",
    };

    const comment = formatFindingComment(finding, ctx, "https://example.com/pull/2");
    expect(comment).not.toContain("`src/routes/orders.ts:84`");
  });

  it("does not include a header like ## Preflex Review", () => {
    const finding: Finding = {
      file: "src/routes/orders.ts",
      line: 34,
      comment: "Something bad here.",
    };

    const comment = formatFindingComment(finding, ctx);
    expect(comment).not.toContain("## Preflex Review");
    expect(comment).not.toContain("Preflex Review");
  });
});

describe("formatFindingsForAgent", () => {
  it("formats findings as numbered summaries for the fix agent", () => {
    const findings: Finding[] = [
      { file: "src/routes/orders.ts", line: 84, comment: "Bad ILIKE query." },
      { file: "src/routes/dashboard.ts", line: 20, comment: "Complex GROUP BY." },
    ];

    const text = formatFindingsForAgent(findings);

    expect(text).toContain("### 1. src/routes/orders.ts:84");
    expect(text).toContain("Bad ILIKE query.");
    expect(text).toContain("### 2. src/routes/dashboard.ts:20");
    expect(text).toContain("Complex GROUP BY.");
  });
});

describe("mock-review-response fixture", () => {
  it("parses as a valid RawFinding[] JSON array", () => {
    const raw = readFileSync(join(fixturesDir, "mock-review-response.json"), "utf-8");
    const findings: RawFinding[] = JSON.parse(raw);

    expect(Array.isArray(findings)).toBe(true);
    expect(findings.length).toBe(6);

    for (const f of findings) {
      expect(f).toHaveProperty("file");
      expect(f).toHaveProperty("code");
      expect(f).toHaveProperty("comment");
      expect(typeof f.file).toBe("string");
      expect(typeof f.code).toBe("string");
      expect(typeof f.comment).toBe("string");
    }
  });

  it("references expected files", () => {
    const findings: RawFinding[] = JSON.parse(
      readFileSync(join(fixturesDir, "mock-review-response.json"), "utf-8"),
    );
    const files = findings.map((f) => f.file);

    expect(files).toContain("src/routes/orders.ts");
    expect(files).toContain("src/routes/service-logs.ts");
    expect(files).toContain("src/routes/inventory.ts");
    expect(files).toContain("src/routes/dashboard.ts");
  });
});

describe("sample-diff.txt fixture", () => {
  it("contains all expected bad patterns", () => {
    const diff = readFileSync(join(fixturesDir, "sample-diff.txt"), "utf-8");

    // Full-text search via ILIKE
    expect(diff).toContain("description ILIKE $1 OR key_type ILIKE $1");

    // Autocomplete via ILIKE prefix
    expect(diff).toContain("WHERE description ILIKE $1");
    expect(diff).toContain("LIMIT 5");

    // Log search via LIKE
    expect(diff).toContain("WHERE message LIKE $1");

    // Fuzzy matching via pg_trgm
    expect(diff).toContain("similarity(message, $1)");

    // Faceted search via ILIKE
    expect(diff).toContain("sku ILIKE");
    expect(diff).toContain("brand ILIKE");

    // Complex aggregations
    expect(diff).toContain("GROUP BY service_type, technician, DATE_TRUNC");
    expect(diff).toContain("GROUP BY key_type, brand");
    expect(diff).toContain("GROUP BY DATE_TRUNC('week', order_date), store");
  });

  it("filterDiffToTsJs strips non-TS/JS files from the diff", () => {
    const diff = readFileSync(join(fixturesDir, "sample-diff.txt"), "utf-8");
    const filtered = filterDiffToTsJs(diff);
    const diffHeaders = filtered
      .split("\n")
      .filter((l) => l.startsWith("diff --git"));

    expect(diffHeaders.length).toBeGreaterThan(0);
    for (const header of diffHeaders) {
      expect(header).toMatch(/\.(ts|js)$/);
    }

    // pgsync.yml should be stripped
    expect(filtered).not.toContain("pgsync.yml");
  });
});
