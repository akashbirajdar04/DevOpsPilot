import { execa } from "execa";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

/**
 * Protected file patterns that automated remediation must never modify.
 */
export const PROTECTED_FILE_PATTERNS = [
  /^\.github\/workflows\//i,
  /^\.env(?:\..+)?$/i,
  /(?:^|\/)\.env(?:\..+)?$/i,
  /(?:^|\/)package-lock\.json$/i,
  /(?:^|\/)yarn\.lock$/i,
  /(?:^|\/)pnpm-lock\.yaml$/i,
  /(?:^|\/)bun\.lockb$/i,
  /^\.git\//i,
  /^\.npmrc$/i,
  /^\.ssh\//i,
];

/**
 * Checks if a given file path targets a protected file or directory.
 * @param {string} filePath
 * @returns {boolean}
 */
export function isProtectedFile(filePath) {
  if (!filePath || typeof filePath !== "string") return true;
  const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  return PROTECTED_FILE_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * Formats a patch so it contains valid git unified diff headers for `git apply`.
 * If headers are missing, wraps the hunk with standard `--- a/file` and `+++ b/file`.
 *
 * @param {string} patchText
 * @param {string} targetFile
 * @returns {string}
 */
export function normalizeGitPatch(patchText, targetFile) {
  if (!patchText) return "";
  let text = patchText.replace(/\r\n/g, "\n").trim();
  const cleanPath = targetFile.replace(/\\/g, "/").replace(/^\.\//, "");

  // If patch already has diff headers
  if (text.startsWith("--- ") || text.startsWith("diff --git")) {
    return text + "\n";
  }

  // Prepend standard unified diff header for targetFile
  return `--- a/${cleanPath}\n+++ b/${cleanPath}\n${text}\n`;
}

export class GitPatchApplier {
  /**
   * @param {object} options
   * @param {string} options.workspaceDir - Path to local git repository
   * @param {number} [options.maxChangedLines=150] - Maximum allowable changed lines
   * @param {number} [options.maxPatchBytes=32000] - Maximum patch size in bytes
   * @param {object} [options.logger=console]
   */
  constructor({ workspaceDir, maxChangedLines = 150, maxPatchBytes = 32000, logger = console }) {
    this.workspaceDir = path.resolve(workspaceDir);
    this.maxChangedLines = maxChangedLines;
    this.maxPatchBytes = maxPatchBytes;
    this.logger = logger;
    this.originalCommitSha = null;
  }

  /**
   * Record the original commit SHA of the workspace before applying any patches.
   * @returns {Promise<string>}
   */
  async recordOriginalCommit() {
    try {
      const { stdout } = await execa("git", ["rev-parse", "HEAD"], {
        cwd: this.workspaceDir,
      });
      this.originalCommitSha = stdout.trim();
      return this.originalCommitSha;
    } catch (err) {
      this.logger.warn(`Could not record git commit SHA: ${err.message}`);
      this.originalCommitSha = null;
      return null;
    }
  }

  /**
   * Validate safety rules on target file before touching git.
   * @param {string} targetFile
   * @param {string[]} allowedFiles
   * @returns {{ safe: boolean, reason?: string }}
   */
  checkTargetSafety(targetFile, allowedFiles = []) {
    const cleanTarget = targetFile.replace(/\\/g, "/").replace(/^\.\//, "");

    // 1. Protected file check
    if (isProtectedFile(cleanTarget)) {
      return { safe: false, reason: `Modification to protected file '${cleanTarget}' is strictly prohibited.` };
    }

    // 2. Allowlist check
    if (allowedFiles.length > 0) {
      const normalizedAllowed = allowedFiles.map((f) => f.replace(/\\/g, "/").replace(/^\.\//, ""));
      const isAllowed = normalizedAllowed.some(
        (allowed) => allowed === cleanTarget || allowed.endsWith(cleanTarget) || cleanTarget.endsWith(allowed)
      );
      if (!isAllowed) {
        return {
          safe: false,
          reason: `File '${cleanTarget}' is not in the allowlist of permitted files: [${normalizedAllowed.join(", ")}].`,
        };
      }
    }

    return { safe: true };
  }

  /**
   * Validate and apply a unified diff patch to the workspace using git apply.
   *
   * @param {object} params
   * @param {string} params.patchText - Unified diff content
   * @param {string} params.targetFile - Intended target file
   * @param {string[]} [params.allowedFiles=[]] - Whitelist of files allowed to be modified
   * @returns {Promise<{
   *   success: boolean,
   *   modifiedFiles: string[],
   *   diff?: string,
   *   changedLines?: number,
   *   reason?: string
   * }>}
   */
  async applyPatch({ patchText, targetFile, allowedFiles = [] }) {
    if (!patchText || !patchText.trim()) {
      return { success: false, modifiedFiles: [], reason: "Patch content is empty." };
    }

    if (Buffer.byteLength(patchText, "utf-8") > this.maxPatchBytes) {
      return {
        success: false,
        modifiedFiles: [],
        reason: `Patch size (${Buffer.byteLength(patchText, "utf-8")} bytes) exceeds limit of ${this.maxPatchBytes} bytes.`,
      };
    }

    // 1. Validate target safety
    const safety = this.checkTargetSafety(targetFile, allowedFiles);
    if (!safety.safe) {
      return { success: false, modifiedFiles: [], reason: safety.reason };
    }

    // Ensure we have original commit recorded
    if (!this.originalCommitSha) {
      await this.recordOriginalCommit();
    }

    const fullPatch = normalizeGitPatch(patchText, targetFile);

    // Write patch to a temporary file for git apply
    const tempPatchFile = path.join(os.tmpdir(), `healops-patch-${Date.now()}-${Math.random().toString(36).slice(2)}.patch`);
    await fs.writeFile(tempPatchFile, fullPatch, "utf-8");

    try {
      // 2. Check patch with `git apply --check`
      try {
        await execa("git", ["apply", "--check", "--ignore-whitespace", tempPatchFile], {
          cwd: this.workspaceDir,
        });
      } catch (checkErr) {
        return {
          success: false,
          modifiedFiles: [],
          reason: `Git patch validation ('git apply --check') failed: ${(checkErr.stderr || checkErr.message || "").trim()}`,
        };
      }

      // 3. Apply patch with `git apply`
      try {
        await execa("git", ["apply", "--ignore-whitespace", tempPatchFile], {
          cwd: this.workspaceDir,
        });
      } catch (applyErr) {
        return {
          success: false,
          modifiedFiles: [],
          reason: `Git patch application ('git apply') failed: ${(applyErr.stderr || applyErr.message || "").trim()}`,
        };
      }

      // 4. Inspect modified files using `git diff --name-only`
      const { stdout: diffNameOnly } = await execa("git", ["diff", "--name-only"], {
        cwd: this.workspaceDir,
      });
      const modifiedFiles = diffNameOnly
        .split("\n")
        .map((f) => f.trim().replace(/\\/g, "/"))
        .filter(Boolean);

      // Verify no protected or unauthorized files were modified
      for (const mod of modifiedFiles) {
        if (isProtectedFile(mod)) {
          await this.rollback();
          return {
            success: false,
            modifiedFiles: [],
            reason: `Patch illegally modified protected file '${mod}'. Rolled back workspace.`,
          };
        }

        if (allowedFiles.length > 0) {
          const cleanAllowed = allowedFiles.map((f) => f.replace(/\\/g, "/").replace(/^\.\//, ""));
          const match = cleanAllowed.some((a) => a === mod || a.endsWith(mod) || mod.endsWith(a));
          if (!match) {
            await this.rollback();
            return {
              success: false,
              modifiedFiles: [],
              reason: `Patch modified unauthorized file '${mod}' not in allowlist. Rolled back workspace.`,
            };
          }
        }
      }

      // 5. Inspect status for untracked / deleted files
      const { stdout: statusPorcelain } = await execa("git", ["status", "--porcelain"], {
        cwd: this.workspaceDir,
      });
      const statusLines = statusPorcelain.split("\n").map((l) => l.trim()).filter(Boolean);
      for (const line of statusLines) {
        if (line.startsWith("??")) {
          await this.rollback();
          return {
            success: false,
            modifiedFiles: [],
            reason: `Patch created unexpected untracked file '${line.slice(3)}'. Rolled back workspace.`,
          };
        }
        if (line.startsWith("D ") || line.startsWith(" D")) {
          await this.rollback();
          return {
            success: false,
            modifiedFiles: [],
            reason: `Patch unexpectedly deleted file '${line.slice(2).trim()}'. Rolled back workspace.`,
          };
        }
      }

      // 6. Check changed lines limit using `git diff --numstat`
      const { stdout: numstat } = await execa("git", ["diff", "--numstat"], {
        cwd: this.workspaceDir,
      });
      let totalChangedLines = 0;
      for (const line of numstat.split("\n").filter(Boolean)) {
        const parts = line.split(/\s+/);
        const added = parseInt(parts[0], 10) || 0;
        const deleted = parseInt(parts[1], 10) || 0;
        totalChangedLines += added + deleted;
      }

      if (totalChangedLines > this.maxChangedLines) {
        await this.rollback();
        return {
          success: false,
          modifiedFiles: [],
          reason: `Patch modified ${totalChangedLines} lines, exceeding the safety limit of ${this.maxChangedLines} lines. Rolled back workspace.`,
        };
      }

      // 7. Inspect final diff
      const { stdout: finalDiff } = await execa("git", ["diff"], {
        cwd: this.workspaceDir,
      });

      return {
        success: true,
        modifiedFiles,
        diff: finalDiff,
        changedLines: totalChangedLines,
      };
    } finally {
      await fs.rm(tempPatchFile, { force: true }).catch(() => {});
    }
  }

  /**
   * Reset workspace back to the original commit SHA, discarding all changes.
   */
  async rollback() {
    try {
      await execa("git", ["checkout", "--", "."], { cwd: this.workspaceDir });
      await execa("git", ["clean", "-fd"], { cwd: this.workspaceDir });
      if (this.originalCommitSha) {
        await execa("git", ["reset", "--hard", this.originalCommitSha], { cwd: this.workspaceDir });
      }
      this.logger.info?.(`↩️ Workspace successfully reset to clean state (SHA: ${this.originalCommitSha || "HEAD"}).`);
      return true;
    } catch (err) {
      this.logger.error?.(`Failed to rollback workspace: ${err.message}`);
      return false;
    }
  }
}
