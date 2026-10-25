/**
 * Agent tool registry: provides readFile, writeFile, and runTest primitives.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";

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
    const cleanPath = filePath.replace(/^[/\\]+/, "");
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
   * @param {string} filePath - Relative file path
   * @param {number} [startLine] - Optional start line (1-indexed)
   * @param {number} [endLine] - Optional end line (1-indexed)
   * @returns {Promise<string>}
   */
  async getRepoFile(filePath, startLine, endLine) {
    // 1. Check if recently modified in memory
    if (this.modifiedFiles.has(filePath)) {
      const memoryContent = this.modifiedFiles.get(filePath);
      return this._sliceFileLines(memoryContent, startLine, endLine);
    }

    let rawContent = "";
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

    if (!rawContent) return `Error: File '${filePath}' is empty or not found.`;
    return this._sliceFileLines(rawContent, startLine, endLine);
  }

  /**
   * Slice lines or cap content to prevent TPM limit exhaustion.
   */
  _sliceFileLines(content, startLine, endLine) {
    const lines = content.split("\n");
    if (startLine || endLine) {
      const start = Math.max(1, parseInt(startLine, 10) || 1);
      const end = Math.min(lines.length, parseInt(endLine, 10) || lines.length);
      const slice = lines.slice(start - 1, end);
      return slice.map((l, idx) => `${start + idx}: ${l}`).join("\n");
    }

    // Default: Cap to first 70 lines or 2,500 characters
    if (lines.length > 70 || content.length > 2500) {
      return (
        lines.slice(0, 60).join("\n") +
        `\n\n... [Truncated to stay within Groq TPM limit. Showing lines 1-60 of ${lines.length}. Specify startLine/endLine to view specific sections.]`
      );
    }
    return content;
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
