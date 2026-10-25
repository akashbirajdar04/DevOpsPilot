/**
 * Agent tool registry: provides readFile, writeFile, and runTest primitives.
 */

import fs from "node:fs/promises";
import path from "node:path";

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
   * Fetch file content from the local workspace or remote GitHub branch.
   * @param {string} filePath - Relative file path
   * @returns {Promise<string>}
   */
  async getRepoFile(filePath) {
    // 1. Check if recently modified in memory
    if (this.modifiedFiles.has(filePath)) {
      return this.modifiedFiles.get(filePath);
    }

    // 2. Check local workspace filesystem
    try {
      const localPath = this._resolveSafePath(filePath);
      const content = await fs.readFile(localPath, "utf-8");
      return content;
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
            const decoded = Buffer.from(data.content, "base64").toString("utf-8");
            return decoded;
          }
        } catch (remoteErr) {
          return `Error: Could not find file '${filePath}' remotely or locally: ${remoteErr.message}`;
        }
      }
      return `Error: File '${filePath}' not found.`;
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

    return JSON.stringify({
      status: result.exitCode === 0 ? "PASSED (Exit code: 0)" : `FAILED (Exit code: ${result.exitCode})`,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      stdout: result.stdout.slice(-1500),
      stderr: result.stderr.slice(-1500),
      durationMs: result.durationMs,
    });
  }
}
