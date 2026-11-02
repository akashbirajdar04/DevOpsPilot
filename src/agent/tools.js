/**
 * Agent tool registry: provides readFile, writeFile, and runTest primitives.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { cleanRepoFilePath } from "../services/logParser.js";

export class AgentTools {
  /**
   * @param {object} params
   * @param {string} params.workspaceDir - Local directory where repo files reside
   * @param {import("../services/sandbox.js").Sandbox} params.sandbox - Ephemeral sandbox runner
   * @param {import("probot").ProbotOctokit} [params.octokit] - Optional Octokit client for remote fallback
   * @param {string} [params.owner]
   * @param {string} [params.repo]
   * @param {string} [params.ref]
   */
  constructor({ workspaceDir, sandbox, octokit, owner, repo, ref }) {
    this.workspaceDir = path.resolve(workspaceDir);
    this.sandbox = sandbox;
    this.octokit = octokit;
    this.owner = owner;
    this.repo = repo;
    this.ref = ref;

    this.modifiedFiles = new Map(); // filePath -> newContent
    this.lastTestResult = null;
    this.lastTestCommand = null;
  }

  /**
   * Ensure relative path stays strictly within the workspace directory.
   */
  _resolveSafePath(filePath) {
    const cleanPath = cleanRepoFilePath(filePath, this.repo);
    const resolved = path.resolve(this.workspaceDir, cleanPath);
    if (!resolved.startsWith(this.workspaceDir)) {
      throw new Error(`Security violation: Path '${filePath}' escapes workspace boundary.`);
    }
    return resolved;
  }

  /**
   * List files and directories in a workspace directory.
   * @param {string} [dirPath=""] - Relative directory path
   * @returns {Promise<string>}
   */
  async listFiles(dirPath = "") {
    try {
      const targetDir = this._resolveSafePath(dirPath);
      const entries = await fs.readdir(targetDir, { withFileTypes: true });
      const items = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
      return items.join("\n");
    } catch (err) {
      return `Error listing directory '${dirPath}': ${err.message}`;
    }
  }

  /**
   * Fetch file content from the local workspace or remote GitHub branch.
   * Returns a focused line window if targetLine is provided, capped at 1,800 characters.
   *
   * @param {object|string} params - { filePath, targetLine = null, window = 25 } or filePath string
   * @param {number} [legacyStart]
   * @param {number} [legacyEnd]
   * @returns {Promise<string>}
   */
  async getRepoFile(params, legacyStart, legacyEnd) {
    let filePath;
    let targetLine = null;
    let window = 25;

    if (typeof params === "string") {
      filePath = params;
      if (typeof legacyStart === "number") targetLine = legacyStart;
      if (typeof legacyEnd === "number") window = legacyEnd;
    } else if (params && typeof params === "object") {
      filePath = params.filePath || params.path;
      targetLine = params.targetLine ?? params.line ?? null;
      window = params.window ?? 25;
    }

    if (!filePath) {
      return "Error: filePath is required for getRepoFile.";
    }

    // 1. Check if recently modified in memory
    let rawContent = "";
    if (this.modifiedFiles.has(filePath)) {
      rawContent = this.modifiedFiles.get(filePath);
    } else {
      // 2. Check local workspace filesystem
      try {
        const localPath = this._resolveSafePath(filePath);
        rawContent = await fs.readFile(localPath, "utf-8");
      } catch {
        // 3. Fallback to remote Octokit getContent if available
        if (this.octokit && this.owner && this.repo) {
          try {
            const { data } = await this.octokit.rest.repos.getContent({
              owner: this.owner,
              repo: this.repo,
              path: filePath,
              ref: this.ref,
            });
            if (!Array.isArray(data) && data.content) {
              rawContent = Buffer.from(data.content, "base64").toString("utf-8");
            }
          } catch (remoteErr) {
            return `Error: Could not find file '${filePath}' remotely or locally: ${remoteErr.message}`;
          }
        } else {
          return `Error: File '${filePath}' not found.`;
        }
      }
    }

    if (!rawContent) return `Error: File '${filePath}' is empty or not found.`;
    return this._formatLineWindow(rawContent, targetLine, window);
  }

  /**
   * Return only lines (targetLine - window) to (targetLine + window) with line numbers prepended.
   * Capped to a hard limit of 1,800 characters (~450 tokens).
   *
   * @param {string} content - Raw file content
   * @param {number|null} [targetLine=null] - Target center line
   * @param {number} [window=25] - Lines before and after
   * @returns {string}
   */
  _formatLineWindow(content, targetLine = null, window = 25) {
    const lines = content.split("\n");
    let output = "";

    if (targetLine !== null && targetLine !== undefined && !isNaN(parseInt(targetLine, 10))) {
      const target = parseInt(targetLine, 10);
      const win = parseInt(window, 10) || 25;
      const start = Math.max(1, target - win);
      const end = Math.min(lines.length, target + win);
      output = lines
        .slice(start - 1, end)
        .map((l, idx) => `${start + idx}: ${l}`)
        .join("\n");
    } else {
      output = content;
    }

    const HARD_LIMIT = 1800;
    const TRUNCATION_NOTICE = "\n// [Remaining lines omitted to stay within token limits]";
    if (output.length > HARD_LIMIT) {
      output = output.slice(0, HARD_LIMIT) + TRUNCATION_NOTICE;
    }

    return output;
  }

  /**
   * Surgically replace targetContent with replacementContent in a file.
   * @param {string} filePath - Relative file path
   * @param {string} targetContent - Exact text to replace
   * @param {string} replacementContent - New text to insert
   * @returns {Promise<string>}
   */
  async replaceInFile(filePath, targetContent, replacementContent) {
    try {
      const localPath = this._resolveSafePath(filePath);
      let content = "";
      if (this.modifiedFiles.has(filePath)) {
        content = this.modifiedFiles.get(filePath);
      } else {
        content = await fs.readFile(localPath, "utf-8");
      }

      if (!content.includes(targetContent)) {
        return `Error: targetContent was not found in '${filePath}'. Make sure the target text matches existing code exactly.`;
      }

      const updated = content.replace(targetContent, replacementContent);
      await fs.mkdir(path.dirname(localPath), { recursive: true });
      await fs.writeFile(localPath, updated, "utf-8");

      this.modifiedFiles.set(filePath, updated);
      return `Successfully replaced targeted content in '${filePath}'.`;
    } catch (err) {
      return `Error replacing content in '${filePath}': ${err.message}`;
    }
  }

  /**
   * Fast git grep search across the codebase.
   * @param {string} query - Symbol or string to search for
   * @returns {Promise<string>}
   */
  async searchCodebase(query) {
    try {
      const { stdout } = await execa("git", ["grep", "-n", "-I", "--max-count=15", query], {
        cwd: this.workspaceDir,
      });
      return stdout.slice(0, 1000) || `No matches found for '${query}'.`;
    } catch {
      return `No matches found for '${query}'.`;
    }
  }

  /**
   * Write updated content to a file in the workspace.
   * @param {string} filePath - Relative file path
   * @param {string} newContent - Full new content
   * @returns {Promise<string>}
   */
  async applyFilePatch(filePath, newContent) {
    try {
      const localPath = this._resolveSafePath(filePath);
      await fs.mkdir(path.dirname(localPath), { recursive: true });
      await fs.writeFile(localPath, newContent, "utf-8");

      this.modifiedFiles.set(filePath, newContent);
      return `Successfully patched '${filePath}' (${newContent.length} bytes written).`;
    } catch (err) {
      return `Error applying patch to '${filePath}': ${err.message}`;
    }
  }

  /**
   * Execute a test or build verification command inside the sandbox.
   * @param {string} command - Shell command to execute
   * @returns {Promise<string>} JSON string of execution result
   */
  async runSandboxTest(command) {
    this.lastTestCommand = command;
    const result = await this.sandbox.runCommand(command);
    this.lastTestResult = result;

    const note = this.modifiedFiles.size === 0 && result.exitCode === 0
      ? "\n[NOTICE: Test exited with 0, but no code files have been modified yet. You must apply a code patch to the failing file to complete remediation.]"
      : "";

    return JSON.stringify({
      status: result.exitCode === 0 ? "PASSED (Exit code: 0)" : `FAILED (Exit code: ${result.exitCode})`,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      stdout: (result.stdout.slice(-1500) + note).trim(),
      stderr: result.stderr.slice(-1500),
      durationMs: result.durationMs,
    });
  }
}
