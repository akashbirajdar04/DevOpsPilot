import fs from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { parseESLintJson, extractVerificationDiagnostics } from "./logParser.js";

/**
 * Detect available CI verification checks from package.json in workspace.
 * Resolves both root and subproject package.json (e.g. frontend/package.json).
 *
 * @param {string} workspaceDir
 * @param {string} [primaryTargetFile=""]
 * @returns {Promise<{
 *   cwd: string,
 *   subDir: string,
 *   hasPkg: boolean,
 *   checks: {
 *     lint?: { command: string, cwd: string },
 *     typecheck?: { command: string, cwd: string },
 *     build?: { command: string, cwd: string },
 *     tests?: { command: string, cwd: string }
 *   }
 * }>}
 */
export async function detectProjectChecks(workspaceDir, primaryTargetFile = "") {
  const normTarget = primaryTargetFile.replace(/\\/g, "/");
  const subDir = normTarget.includes("/") ? normTarget.split("/")[0] : "";

  let targetCwd = workspaceDir;
  let pkgData = null;
  let detectedSubDir = "";

  // 1. Check subproject package.json first if target is inside a subfolder
  if (subDir) {
    const subPkgPath = path.join(workspaceDir, subDir, "package.json");
    try {
      const raw = await fs.readFile(subPkgPath, "utf-8");
      pkgData = JSON.parse(raw);
      targetCwd = path.join(workspaceDir, subDir);
      detectedSubDir = subDir;
    } catch {}
  }

  // 2. Fall back to root package.json
  if (!pkgData) {
    const rootPkgPath = path.join(workspaceDir, "package.json");
    try {
      const raw = await fs.readFile(rootPkgPath, "utf-8");
      pkgData = JSON.parse(raw);
      targetCwd = workspaceDir;
      detectedSubDir = "";
    } catch {}
  }

  if (!pkgData) {
    return { cwd: workspaceDir, subDir: "", hasPkg: false, checks: {} };
  }

  const scripts = pkgData.scripts || {};
  const checks = {};
  const prefixFlag = detectedSubDir ? ` --prefix ${detectedSubDir}` : "";

  // Lint check
  if (scripts.lint) {
    checks.lint = {
      command: `npm run lint${prefixFlag}`,
      cwd: workspaceDir,
    };
  }

  // TypeScript check
  if (scripts["type-check"] || scripts.typecheck || scripts.tsc) {
    const scriptName = scripts["type-check"] ? "type-check" : scripts.typecheck ? "typecheck" : "tsc";
    checks.typecheck = {
      command: `npm run ${scriptName}${prefixFlag}`,
      cwd: workspaceDir,
    };
  } else {
    // Check if tsconfig.json exists
    const hasTsConfig = await fs
      .stat(path.join(targetCwd, "tsconfig.json"))
      .then(() => true)
      .catch(() => false);
    if (hasTsConfig && (pkgData.devDependencies?.typescript || pkgData.dependencies?.typescript)) {
      checks.typecheck = {
        command: `npx tsc --noEmit${prefixFlag}`,
        cwd: workspaceDir,
      };
    }
  }

  // Build check
  if (scripts.build) {
    checks.build = {
      command: `npm run build${prefixFlag}`,
      cwd: workspaceDir,
    };
  }

  // Unit tests check (ignore default echo error placeholder)
  if (scripts.test && !scripts.test.includes("no test specified")) {
    checks.tests = {
      command: `npm test${prefixFlag}`,
      cwd: workspaceDir,
    };
  }

  return {
    cwd: targetCwd,
    subDir: detectedSubDir,
    hasPkg: true,
    checks,
  };
}

/**
 * Execute a single shell command safely with timeout and output capture.
 *
 * @param {string} command
 * @param {string} cwd
 * @param {number} [timeout=60000]
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string, timedOut: boolean, durationMs: number }>}
 */
export async function runCommandSafe(command, cwd, timeout = 60000) {
  const startTime = Date.now();
  try {
    const result = await execa(command, {
      cwd,
      shell: true,
      timeout,
      reject: false,
      env: {
        ...process.env,
        CI: "true",
        NODE_ENV: "development",
      },
    });

    return {
      exitCode: result.exitCode ?? (result.failed ? 1 : 0),
      stdout: (result.stdout || "").slice(-50000),
      stderr: (result.stderr || "").slice(-50000),
      timedOut: result.timedOut || false,
      durationMs: Date.now() - startTime,
    };
  } catch (err) {
    const isTimeout = err.timedOut || Date.now() - startTime >= timeout;
    return {
      exitCode: isTimeout ? 124 : 1,
      stdout: (err.stdout || "").slice(-50000),
      stderr: (err.stderr || err.message || "").slice(-50000),
      timedOut: isTimeout,
      durationMs: Date.now() - startTime,
    };
  }
}

export class CIVerifier {
  /**
   * @param {object} options
   * @param {string} options.workspaceDir
   * @param {number} [options.timeout=60000]
   * @param {object} [options.logger=console]
   */
  constructor({ workspaceDir, timeout = 60000, logger = console }) {
    this.workspaceDir = path.resolve(workspaceDir);
    this.timeout = timeout;
    this.logger = logger;
  }

  /**
   * Run all detected CI checks independently, capturing metrics for each.
   *
   * @param {object} [options]
   * @param {string} [options.primaryTargetFile]
   * @param {object} [options.explicitChecks] - Optional override of checks to execute
   * @returns {Promise<{
   *   finalState: "VERIFIED" | "FAILED" | "INCOMPLETE" | "REJECTED",
   *   results: {
   *     lint?: { status: string, errors: number, warnings: number, exitCode: number, command: string, durationMs: number },
   *     build?: { status: string, exitCode: number, command: string, durationMs: number },
   *     tests?: { status: string, exitCode: number, command: string, durationMs: number },
   *     typecheck?: { status: string, exitCode: number, command: string, durationMs: number }
   *   },
   *   summary: string,
   *   failureReason?: string
   * }>}
   */
  async runVerification(options = {}) {
    const { primaryTargetFile = "", explicitChecks = null } = options;

    let checksToRun = explicitChecks;
    if (!checksToRun) {
      const detection = await detectProjectChecks(this.workspaceDir, primaryTargetFile);
      if (!detection.hasPkg || Object.keys(detection.checks).length === 0) {
        return {
          finalState: "INCOMPLETE",
          results: {},
          summary: "No verification commands (lint, build, test) found in repository configuration.",
          failureReason: "Missing verification command.",
        };
      }
      checksToRun = detection.checks;
    }

    const results = {};
    const failureReasons = [];
    let hasIncomplete = false;
    let hasFailure = false;

    // 1. Lint Check
    if (checksToRun.lint) {
      const lintConfig = checksToRun.lint;
      this.logger.info?.(`[CI Verification] Executing Lint: '${lintConfig.command}'...`);

      // Attempt to execute with --format json to derive errors and warnings from the exact same execution
      const jsonCmd = `${lintConfig.command} -- --format json`;
      let execResult = await runCommandSafe(jsonCmd, lintConfig.cwd || this.workspaceDir, this.timeout);

      let parsedJson = null;
      if (!execResult.timedOut) {
        parsedJson = parseESLintJson(execResult.stdout);
      }

      // If json flag was rejected or not supported by custom script, run standard command
      if (!parsedJson && !execResult.timedOut) {
        execResult = await runCommandSafe(lintConfig.command, lintConfig.cwd || this.workspaceDir, this.timeout);
        const diag = extractVerificationDiagnostics(
          (execResult.stdout + "\n" + execResult.stderr).trim(),
          execResult.exitCode
        );
        parsedJson = {
          fatalErrors: diag.fatalErrors,
          warnings: diag.warnings,
          errorCount: diag.errorCount,
          warningCount: diag.warningCount,
        };
      }

      if (execResult.timedOut) {
        hasIncomplete = true;
        results.lint = {
          status: "incomplete",
          errors: 0,
          warnings: 0,
          exitCode: 124,
          command: lintConfig.command,
          durationMs: execResult.durationMs,
        };
        failureReasons.push(`Lint check timed out after ${this.timeout}ms`);
      } else {
        const errorCount = parsedJson?.errorCount ?? (execResult.exitCode === 0 ? 0 : 1);
        const warningCount = parsedJson?.warningCount ?? 0;
        const lintPassed = execResult.exitCode === 0 && errorCount === 0;

        results.lint = {
          status: lintPassed ? "passed" : "failed",
          errors: errorCount,
          warnings: warningCount,
          exitCode: execResult.exitCode,
          command: lintConfig.command,
          durationMs: execResult.durationMs,
        };

        if (!lintPassed) {
          hasFailure = true;
          failureReasons.push(`Lint check failed with ${errorCount} error(s) (exit code ${execResult.exitCode})`);
          const diagLines = (execResult.stderr || execResult.stdout || "").trim().split("\n").slice(-25).join("\n");
          this.logger.error?.(`[CI Verification] Lint FAILED (exit code ${execResult.exitCode}):\n${diagLines}`);
        }
      }
    }

    // 2. TypeScript / TypeCheck
    if (checksToRun.typecheck) {
      const tcConfig = checksToRun.typecheck;
      this.logger.info?.(`[CI Verification] Executing TypeCheck: '${tcConfig.command}'...`);
      const tcResult = await runCommandSafe(tcConfig.command, tcConfig.cwd || this.workspaceDir, this.timeout);

      if (tcResult.timedOut) {
        hasIncomplete = true;
        results.typecheck = {
          status: "incomplete",
          exitCode: 124,
          command: tcConfig.command,
          durationMs: tcResult.durationMs,
        };
        failureReasons.push(`TypeScript check timed out after ${this.timeout}ms`);
      } else {
        const passed = tcResult.exitCode === 0;
        results.typecheck = {
          status: passed ? "passed" : "failed",
          exitCode: tcResult.exitCode,
          command: tcConfig.command,
          durationMs: tcResult.durationMs,
        };
        if (!passed) {
          hasFailure = true;
          failureReasons.push(`TypeScript check failed (exit code ${tcResult.exitCode})`);
        }
      }
    }

    // 3. Build Check
    if (checksToRun.build) {
      const buildConfig = checksToRun.build;
      this.logger.info?.(`[CI Verification] Executing Build: '${buildConfig.command}'...`);
      const buildResult = await runCommandSafe(buildConfig.command, buildConfig.cwd || this.workspaceDir, this.timeout);

      if (buildResult.timedOut) {
        hasIncomplete = true;
        results.build = {
          status: "incomplete",
          exitCode: 124,
          command: buildConfig.command,
          durationMs: buildResult.durationMs,
        };
        failureReasons.push(`Build check timed out after ${this.timeout}ms`);
      } else {
        const passed = buildResult.exitCode === 0;
        results.build = {
          status: passed ? "passed" : "failed",
          exitCode: buildResult.exitCode,
          command: buildConfig.command,
          durationMs: buildResult.durationMs,
        };
        if (!passed) {
          hasFailure = true;
          failureReasons.push(`Build check failed (exit code ${buildResult.exitCode})`);
          const diagLines = (buildResult.stderr || buildResult.stdout || "").trim().split("\n").slice(-25).join("\n");
          this.logger.error?.(`[CI Verification] Build FAILED (exit code ${buildResult.exitCode}):\n${diagLines}`);
        }
      }
    }

    // 4. Test Check
    if (checksToRun.tests) {
      const testConfig = checksToRun.tests;
      this.logger.info?.(`[CI Verification] Executing Tests: '${testConfig.command}'...`);
      const testResult = await runCommandSafe(testConfig.command, testConfig.cwd || this.workspaceDir, this.timeout);

      if (testResult.timedOut) {
        hasIncomplete = true;
        results.tests = {
          status: "incomplete",
          exitCode: 124,
          command: testConfig.command,
          durationMs: testResult.durationMs,
        };
        failureReasons.push(`Tests check timed out after ${this.timeout}ms`);
      } else {
        const passed = testResult.exitCode === 0;
        results.tests = {
          status: passed ? "passed" : "failed",
          exitCode: testResult.exitCode,
          command: testConfig.command,
          durationMs: testResult.durationMs,
        };
        if (!passed) {
          hasFailure = true;
          failureReasons.push(`Tests failed (exit code ${testResult.exitCode})`);
        }
      }
    }

    // Determine final remediation state
    let finalState = "VERIFIED";
    if (hasIncomplete) {
      finalState = "INCOMPLETE";
    } else if (hasFailure) {
      finalState = "FAILED";
    }

    const summary =
      finalState === "VERIFIED"
        ? `All ${Object.keys(results).length} verification check(s) passed successfully.`
        : `Verification completed with state ${finalState}: ${failureReasons.join("; ")}`;

    return {
      finalState,
      results,
      summary,
      failureReason: failureReasons.length > 0 ? failureReasons.join("; ") : undefined,
    };
  }
}

