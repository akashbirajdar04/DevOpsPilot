/**
 * HealOps: Autonomous Self-Healing CI/CD GitHub App Agent
 * Single-Shot Deterministic Remediation Pipeline
 */

import "dotenv/config";
import { execa } from "execa";
import { DiagnoserAgent } from "./src/agent/diagnoser.js";
import { AgentTools } from "./src/agent/tools.js";
import { GitOpsService } from "./src/services/gitOps.js";
import { extractAllCulprits, extractCulpritLocation, extractFatalErrorLine, getLineWindow, extractRawLogText, cleanRepoFilePath } from "./src/services/logParser.js";
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
    const runId = workflow_run.id;
    const headBranch = workflow_run.head_branch;
    const conclusion = workflow_run.conclusion;
    const owner = repository.owner.login;
    const repo = repository.name;

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
      return;
    }

    // -------------------------------------------------------------------------
    // Guard 2: Only handle genuine failures
    // -------------------------------------------------------------------------
    if (conclusion !== "failure") {
      app.log.info(`Skipping non-failure run conclusion: '${conclusion}'`);
      return;
    }

    // -------------------------------------------------------------------------
    // Guard 3: Anti-Infinite Recursion Loop Guard
    // -------------------------------------------------------------------------
    if (headBranch && headBranch.startsWith("fix/ci-")) {
      app.log.info(
        `[ANTI-LOOP GUARD] Skipping run #${runId} on '${headBranch}' to prevent recursive remediation trigger.`
      );
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
    // Step 2: Deterministic Culprit Extraction (single or multi-file)
    // -------------------------------------------------------------------------
    let culprits = extractAllCulprits(logText, repo);

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
        await execa(`npm ci --prefer-offline || npm install --prefer-offline`, {
          cwd: installCwd,
          shell: true,
          timeout: 120000,
        });
      } catch (npmErr) {
        app.log.warn(`Sandbox dependency install note: ${npmErr.message}`);
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
        model: process.env.GROQ_MODEL || "llama-3.1-8b-instant",
        logger: app.log,
      });

      // Dynamically select verification command for sandbox
      let testCommand = "npm test --if-present";
      const primaryTargetFile = culprits[0].targetFile;
      const targetSubDir = primaryTargetFile.includes("/") ? primaryTargetFile.split("/")[0] : "";
      const rootPkgPath = path.join(workspaceDir, "package.json");
      const subPkgPath = targetSubDir ? path.join(workspaceDir, targetSubDir, "package.json") : null;

      try {
        if (subPkgPath) {
          const subPkgRaw = await fs.readFile(subPkgPath, "utf-8");
          const subPkg = JSON.parse(subPkgRaw);
          const cmds = [];
          if (subPkg.scripts?.lint) cmds.push(`npm run lint --prefix ${targetSubDir}`);
          if (subPkg.scripts?.test) cmds.push(`npm test --prefix ${targetSubDir}`);
          if (subPkg.scripts?.build) cmds.push(`npm run build --prefix ${targetSubDir}`);
          if (cmds.length > 0) {
            testCommand = cmds.join(" && ");
          } else {
            testCommand = `npm test --if-present --prefix ${targetSubDir}`;
          }
        } else {
          const rootPkgRaw = await fs.readFile(rootPkgPath, "utf-8");
          const rootPkg = JSON.parse(rootPkgRaw);
          const cmds = [];
          if (rootPkg.scripts?.lint) cmds.push("npm run lint");
          if (rootPkg.scripts?.test) cmds.push("npm test");
          if (rootPkg.scripts?.build) cmds.push("npm run build");
          if (cmds.length > 0) {
            testCommand = cmds.join(" && ");
          } else {
            testCommand = "npm test --if-present";
          }
        }
      } catch {
        testCommand = "npm test --if-present";
      }

      app.log.info(`Dispatching deterministic remediation for Run #${runId} across ${culprits.length} file(s)...`);
      const remediation = await agent.runMultiFileRemediation({
        culprits,
        testCommand,
        delayMs: parseInt(process.env.GROQ_TURN_DELAY_MS || "2000", 10),
      });

      // -----------------------------------------------------------------------
      // Step 5: PR Delivery (if verified) or Clean Exit (if unverified)
      // -----------------------------------------------------------------------
      if (!remediation.success) {
        app.log.warn(
          `Remediation was unsuccessful for Run #${runId}. Exiting cleanly without opening a PR.`
        );
        return;
      }

      app.log.info(
        `🎉 Multi-file remediation passed! Pushing to fix/ci-failure-${runId} and opening PR with ${remediation.modifiedFiles.length} file(s)...`
      );


      const gitOps = new GitOpsService(context.octokit, owner, repo);
      const fixBranch = await gitOps.createFixBranch(runId, headBranch);

      const filesMap = Object.fromEntries(tools.modifiedFiles);
      await gitOps.commitFiles(
        fixBranch,
        filesMap,
        `fix(ci): single-shot deterministic remediation for run #${runId}\n\n${remediation.rootCause}`
      );

      const prResult = await gitOps.openPullRequest({
        runId,
        headBranch,
        fixBranch,
        rootCause: remediation.rootCause,
        modifiedFiles: remediation.modifiedFiles,
        testCommand: remediation.testCommand,
        testOutput: remediation.testOutput,
        iterations: 1,
      });

      app.log.info(`🎉 Successfully opened Pull Request: ${prResult.prUrl} (#${prResult.prNumber})`);
    } catch (err) {
      app.log.error(`Unhandled error during single-shot remediation: ${err.message}`);
    } finally {
      await sandbox.cleanup();
    }
  });
}
