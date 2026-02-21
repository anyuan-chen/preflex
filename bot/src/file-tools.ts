// file-tools.ts — read_file / write_file tool implementations for the fix agent

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface FileToolResult {
  success: boolean;
  content?: string;
  error?: string;
}

/**
 * Read a file from the repository working directory.
 */
export async function readFileTool(
  repoRoot: string,
  path: string,
): Promise<FileToolResult> {
  try {
    const fullPath = path.startsWith("/") ? path : `${repoRoot}/${path}`;
    const content = await readFile(fullPath, "utf-8");
    return { success: true, content };
  } catch (err) {
    return {
      success: false,
      error: `Failed to read ${path}: ${(err as Error).message}`,
    };
  }
}

/**
 * Write a file to the repository working directory.
 */
export async function writeFileTool(
  repoRoot: string,
  path: string,
  content: string,
): Promise<FileToolResult> {
  try {
    const fullPath = path.startsWith("/") ? path : `${repoRoot}/${path}`;
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf-8");
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: `Failed to write ${path}: ${(err as Error).message}`,
    };
  }
}
