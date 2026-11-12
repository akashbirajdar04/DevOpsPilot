/**
 * HealOps: Autonomous Self-Healing CI/CD GitHub App Agent
 * Single-Shot Deterministic Remediation Pipeline
 */

import "dotenv/config";
import { execa } from "execa";
import { DiagnoserAgent } from "./src/agent/diagnoser.js";
import { AgentTools } from "./src/agent/tools.js";
import { GitOpsService } from "./src/services/gitOps.js";
import { extractAllCulprits, extractCulpritLocation, extractFatalErrorLine, getLineWindow, extractRawLogText, cleanRepoFilePath, diagnoseLogErrors } from "./src/services/logParser.js";
import { globalRunLock } from "./src/utils/runLock.js";
import fs from "node:fs/promises";
import path from "node:path";
import { Sandbox } from "./src/services/sandbox.js";

// Store the server boot timestamp when the application starts
export const serverBootTime = new Date();

/**
 * @param {import("probot").Probot} app
 * @param {Date|object} [optionsOrBootTime]
 */
export default function healOpsApp(app, optionsOrBootTime) {
  const bootTime =
    optionsOrBootTime instanceof Date
      ? optionsOrBootTime
      : optionsOrBootTime?.bootTime instanceof Date
      ? optionsOrBootTime.bootTime
      : serverBootTime;

  app.log.info(`🤖 HealOps Single-Shot Remediation Agent initializing (Boot: ${bootTime.toISOString()})...`);

  app.on("workflow_run.completed", async (context) => {
    const { workflow_run, repository } = context.payload;
    const repoId = repository.id || repository.name || "default";
    const runId = workflow_run.id;
    const runAttempt = workflow_run.run_attempt || 1;
    const headBranch = workflow_run.head_branch;
    const conclusion = workflow_run.conclusion;
    const owner = repository.owner.login;
    const repo = repository.name;

    // -------------------------------------------------------------------------
    // Guard 0: In-Flight Run Locking & Idempotency Protection
    // -------------------------------------------------------------------------
    const deliveryId = context.id;
    if (!globalRunLock.acquire(repoId, runId, runAttempt, deliveryId)) {
      app.log.warn(
        `[IDEMPOTENCY GUARD] Workflow Run #${runId} (Attempt ${runAttempt}, Repo: ${repoId}, Delivery: ${deliveryId}) is already processed or actively running. Dropping duplicate event.`
      );
      return;
    }

    // -------------------------------------------------------------------------
    // Guard 1: Drop Stale Replayed Runs from Smee.io
    // -------------------------------------------------------------------------
    const runCompletedAt = new Date(
      workflow_run.updated_at || workflow_run.run_started_at || workflow_run.created_at
    );
    if (runCompletedAt < bootTime) {
      app.log.info(
        `[STALE EVENT] Dropping replayed run from Smee.io (Run #${runId}, completed at ${runCompletedAt.toISOString()})`
      );
      globalRunLock.release(repoId, runId, runAttempt, false);
      return;
    }

    // -------------------------------------------------------------------------
    // Guard 2: Only handle genuine failures
    // -------------------------------------------------------------------------
    if (conclusion !== "failure") {
      app.log.info(`Skipping non-failure run conclusion: '${conclusion}'`);
      globalRunLock.release(repoId, runId, runAttempt, false);
      return;
    }

    // -------------------------------------------------------------------------
    // Guard 3: Anti-Infinite Recursion Loop Guard
    // -------------------------------------------------------------------------
    if (headBranch && headBranch.startsWith("fix/ci-")) {
      app.log.info(
        `[ANTI-LOOP GUARD] Skipping run #${runId} on '${headBranch}' to prevent recursive remediation trigger.`
      );
      globalRunLock.release(repoId, runId, runAttempt, false);
      return;
    }

    app.log.info(
      `Received workflow_run.completed for ${owner}/${repo} (Run #${runId}, Branch: '${headBranch}', Conclusion: '${conclusion}')`
    );

    // -------------------------------------------------------------------------
    // Step 1: Download Workflow Run Logs
    // -------------------------------------------------------------------------
    let rawLogBuffer = "";
    try {
      app.log.info(`Downloading workflow run logs for #${runId}...`);
      const logResponse = await context.octokit.actions.downloadWorkflowRunLogs({
        owner,
        repo,
        run_id: runId,
      });
      rawLogBuffer = logResponse.data;
    } catch (err) {
      app.log.warn(`Could not download full workflow run logs (${err.message}). Attempting job-level logs...`);
      try {
        const { data: jobsData } = await context.octokit.actions.listJobsForWorkflowRun({
          owner,
          repo,
          run_id: runId,
        });
        const failedJob = jobsData.jobs.find((j) => j.conclusion === "failure") || jobsData.jobs[0];
        if (failedJob) {
          const jobLog = await context.octokit.actions.downloadJobLogsForWorkflowRun({
            owner,
            repo,
            job_id: failedJob.id,
          });
          rawLogBuffer = jobLog.data;
        }
      } catch (jobErr) {
        app.log.error(`Failed to fetch job-level logs: ${jobErr.message}`);
      }
    }

    const logText = extractRawLogText(rawLogBuffer || "CI Workflow Job Failed with exit code 1.");

    // -------------------------------------------------------------------------
    // Step 2: Deterministic Culprit Extraction & Log Diagnosis
    // -------------------------------------------------------------------------
    const diagnostics = diagnoseLogErrors(logText, repo);
    let culprits = [];

    if (diagnostics.byFile.size > 0) {
      culprits = Array.from(diagnostics.byFile.entries()).map(([targetFile, errs]) => ({
        targetFile,
        lineNum: errs[0].lineNum || 1,
        errors: errs.map((e) => e.message || e.raw),
        structuredErrors: errs,
      }));
      app.log.info(
        `🎯 Structured log diagnosis identified ${diagnostics.errors.length} error(s) across ${culprits.length} file(s). Categories: ${JSON.stringify(diagnostics.summary.categories)}`
      );
    } else {
      culprits = extractAllCulprits(logText, repo);
    }

    if (!culprits || culprits.length === 0) {
      const single = extractCulpritLocation(logText);
      if (single?.targetFile) {
        const cleanedFile = cleanRepoFilePath(single.targetFile, repo);
        const fatalLine = extractFatalErrorLine(logText, cleanedFile);
        culprits = [{ targetFile: cleanedFile, lineNum: single.lineNum, errors: [fatalLine] }];
      }
    }

    if (!culprits || culprits.length === 0) {
      app.log.warn(`No culprit files detected via regex in Run #${runId} logs. Exiting cleanly.`);
      globalRunLock.release(repoId, runId, runAttempt, false);
      return;
    }

    app.log.info(
      `🎯 Detected ${culprits.length} broken file(s) across codebase:\n${culprits.map((c) => `  • ${c.targetFile} (line ${c.lineNum})`).join("\n")}`
    );

    // -------------------------------------------------------------------------
    // Step 3: Set up Ephemeral Sandbox and Agent Tools
    // -------------------------------------------------------------------------
    const sandbox = new Sandbox();
    const workspaceDir = await sandbox.initWorkspace();

    try {
      const auth = await context.octokit.auth({ type: "installation" });
      const cloneUrl = `https://x-access-token:${auth.token}@github.com/${owner}/${repo}.git`;
      app.log.info(`Cloning ${owner}/${repo} (${headBranch}) into sandbox workspace...`);
      await execa(`git clone --depth 1 --branch ${headBranch} ${cloneUrl} .`, {
        cwd: workspaceDir,
        shell: true,
      });

      // Install dependencies in sandbox if package.json exists
      const targetSubDir = culprits[0]?.targetFile?.includes("/") ? culprits[0].targetFile.split("/")[0] : "";
      const hasSubPkg = targetSubDir && (await fs.stat(path.join(workspaceDir, targetSubDir, "package.json")).catch(() => null));
      const installCwd = hasSubPkg ? path.join(workspaceDir, targetSubDir) : workspaceDir;

      try {
        app.log.info(`Installing dependencies in sandbox (${installCwd})...`);
        await execa(`npm install --no-save --include=dev --prefer-offline`, {
          cwd: installCwd,
          shell: true,
          env: {
            ...process.env,
            NODE_ENV: "development",
          },
          timeout: 180000,
        });
      } catch (npmErr) {
        app.log.warn(`Sandbox dependency install note: ${npmErr.message}`);
      } finally {
        // Discard any unintentional lockfile or working tree modifications from npm install
        await execa(`git checkout -- .`, { cwd: workspaceDir, shell: true }).catch(() => {});
      }
    } catch (cloneErr) {
      app.log.warn(`Could not clone repo into sandbox: ${cloneErr.message}. Falling back to remote Octokit fetching.`);
    }

    const tools = new AgentTools({
      workspaceDir,
      sandbox,
      octokit: context.octokit,
      owner,
      repo,
      ref: headBranch,
    });

    // -------------------------------------------------------------------------
    // Step 4: Multi-File LLM Fixer & Workspace Verification
    // -------------------------------------------------------------------------
    try {
      const agent = new DiagnoserAgent({
        tools,
        apiKey: process.env.GROQ_API_KEY,
        model: process.env.GROQ_MODEL || "openai/gpt-oss-120b",
        logger: app.log,
      });

      app.log.info(`Dispatching deterministic remediation for Run #${runId} across ${culprits.length} file(s)...`);
      const report = await agent.runDeterministicRemediationPipeline({
        culprits,
        repo: `${owner}/${repo}`,
        runId,
        runAttempt,
        deliveryId,
        headBranch,
      });

      // -----------------------------------------------------------------------
      // Step 5: PR Delivery (only if VERIFIED) or Clean Exit (if unverified)
      // -----------------------------------------------------------------------
      if (report.finalState !== "VERIFIED") {
        app.log.warn(
          `Remediation completed with state '${report.finalState}' for Run #${runId} (${report.verification?.summary || report.failureReason || "verification unverified"}). Exiting cleanly without opening a PR.`
        );
        return;
      }

      app.log.info(
        `🎉 Multi-file remediation VERIFIED! Pushing to fix/ci-failure-${runId} and opening PR with ${report.modifiedFiles.length} file(s)...`
      );

      const gitOps = new GitOpsService(context.octokit, owner, repo);
      const fixBranch = await gitOps.createFixBranch(runId, headBranch);

      const filesMap = Object.fromEntries(tools.modifiedFiles);
      await gitOps.commitFiles(
        fixBranch,
        filesMap,
        `fix(ci): verified deterministic remediation for run #${runId}\n\n${report.rootCause}`
      );

      const prResult = await gitOps.openPullRequest({
        runId,
        headBranch,
        fixBranch,
        report,
      });

      app.log.info(`🎉 Successfully opened Pull Request: ${prResult.prUrl} (#${prResult.prNumber})`);
    } catch (err) {
      app.log.error(`Unhandled error during single-shot remediation: ${err.message}`);
    } finally {
      globalRunLock.release(repoId, runId, runAttempt, true);
      await sandbox.cleanup();
    }
  });
}
