/**
 * Ephemeral sandbox runner for validating code repairs using execa or Docker containers.
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execa } from "execa";

export class Sandbox {
  /**
   * @param {string} [workingDir] - Optional root directory for the sandbox.
   */
  constructor(workingDir) {
    this.workingDir = workingDir;
    this.isTemp = false;
  }

  /**
   * Initialize an isolated temporary directory for the workspace if not provided.
   * @returns {Promise<string>}
   */
  async initWorkspace() {
    if (!this.workingDir) {
      this.workingDir = await fs.mkdtemp(path.join(os.tmpdir(), "healops-sandbox-"));
      this.isTemp = true;
    }
    await fs.mkdir(this.workingDir, { recursive: true });
    return this.workingDir;
  }

  /**
   * Execute a command safely in the sandbox workspace.
   * @param {string} command - The shell command to run (e.g., 'npm test', 'pytest')
   * @param {object} [options]
   * @param {number} [options.timeout=60000] - Timeout in milliseconds (default 60s)
   * @param {object} [options.env={}] - Additional environment variables
   * @returns {Promise<{ exitCode: number, stdout: string, stderr: string, timedOut: boolean, durationMs: number }>}
   */
  async runCommand(command, options = {}) {
    const timeout = options.timeout || 60000;
    const startTime = Date.now();
    const cwd = this.workingDir || process.cwd();

    try {
      const result = await execa(command, {
        cwd,
        shell: true,
        timeout,
        reject: false,
        env: {
          ...process.env,
          NODE_ENV: "test",
          CI: "true",
          ...options.env,
        },
      });

      const durationMs = Date.now() - startTime;
      return {
        exitCode: result.exitCode ?? (result.failed ? 1 : 0),
        stdout: result.stdout || "",
        stderr: result.stderr || "",
        timedOut: result.timedOut || false,
        durationMs,
      };
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const isTimeout = err.timedOut || durationMs >= timeout;
      return {
        exitCode: isTimeout ? 124 : 1,
        stdout: err.stdout || "",
        stderr: err.stderr || err.message,
        timedOut: isTimeout,
        durationMs,
      };
    }
  }

  /**
   * Cleanup temporary workspace directory if one was created.
   */
  async cleanup() {
    if (this.isTemp && this.workingDir) {
      try {
        await fs.rm(this.workingDir, { recursive: true, force: true });
      } catch {
        // Silently ignore cleanup errors
      }
    }
  }
}
