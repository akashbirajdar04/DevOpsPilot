/**
 * HealOps: Autonomous Self-Healing CI/CD GitHub App Agent
 * Entry point and event routing via Probot.
 */

import "dotenv/config";
import { execa } from "execa";
import { DiagnoserAgent } from "./src/agent/diagnoser.js";
import { AgentTools } from "./src/agent/tools.js";
import { GitOpsService } from "./src/services/gitOps.js";
import { parseLog, extractCulpritLocation, getLineWindow } from "./src/services/logParser.js";
import { Sandbox } from "./src/services/sandbox.js";

/**
 * @param {import("probot").Probot} app
 */
export default function healOpsApp(app) {
  app.log.info("🤖 HealOps Self-Healing CI/CD Agent is initializing...");

  app.on("workflow_run.completed", async (context) => {
    const { workflow_run, repository } = context.payload;
    const runId = workflow_run.id;
    const headBranch = workflow_run.head_branch;
    const conclusion = workflow_run.conclusion;
    const owner = repository.owner.login;
    const repo = repository.name;

    app.log.info(
      `Received workflow_run.completed for ${owner}/${repo} (Run #${runId}, Branch: '${headBranch}', Conclusion: '${conclusion}')`
    );

    // -------------------------------------------------------------------------
    // Guard 1: Only handle genuine failures
    // -------------------------------------------------------------------------
    if (conclusion !== "failure") {
      app.log.info(`Skipping non-failure run conclusion: '${conclusion}'`);
      return;
    }

    // -------------------------------------------------------------------------
    // Guard 2: Anti-Infinite Recursion Loop Guard
    // -------------------------------------------------------------------------
    if (headBranch && headBranch.startsWith("fix/ci-")) {
      app.log.info(
        `[ANTI-LOOP GUARD] Skipping run #${runId} on '${headBranch}' to prevent recursive remediation trigger.`
      );
      return;
    }

    // -------------------------------------------------------------------------
    // Step 1: Download & Parse Workflow Logs
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

    const { cleanLog, extractedWindow, totalLines, detectedTargets } = parseLog(rawLogBuffer || "CI Workflow Job Failed with exit code 1.", 45);
    app.log.info(
      `Parsed logs: Extracted focused failure window (${extractedWindow.split("\n").length} lines, ${detectedTargets?.length || 0} target addresses) from ${totalLines} total lines.`
    );

    // -------------------------------------------------------------------------
    // Step 2: Set up Ephemeral Sandbox and Agent Tools
    // -------------------------------------------------------------------------
    const sandbox = new Sandbox();
    const workspaceDir = await sandbox.initWorkspace();

    // Clone target repository branch into the ephemeral sandbox workspace using GitHub App installation token
    try {
      const auth = await context.octokit.auth({ type: "installation" });
      const cloneUrl = `https://x-access-token:${auth.token}@github.com/${owner}/${repo}.git`;
      app.log.info(`Cloning ${owner}/${repo} (${headBranch}) into sandbox workspace...`);
      await execa(`git clone --depth 1 --branch ${headBranch} ${cloneUrl} .`, {
        cwd: workspaceDir,
        shell: true,
      });
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
    // Step 2b: Stack-Trace Targeted Extraction (Line Window: lineNum ± 15)
    // -------------------------------------------------------------------------
    const culprit = extractCulpritLocation(cleanLog);
    let culpritContext = null;
    if (culprit?.targetFile && culprit?.lineNum) {
      try {
        const fullContent = await tools.getRepoFile(culprit.targetFile);
        if (fullContent && !fullContent.startsWith("Error:")) {
          const lineWindow = getLineWindow(fullContent, culprit.lineNum, 15);
          culpritContext = {
            targetFile: culprit.targetFile,
            lineNum: culprit.lineNum,
            lineWindow,
          };
          app.log.info(
            `Extracted targeted line window for '${culprit.targetFile}' centered at line ${culprit.lineNum} (window: 30 lines).`
          );
        }
      } catch (err) {
        app.log.warn(`Could not extract line window for culprit file: ${err.message}`);
      }
    }

    const agent = new DiagnoserAgent({
      tools,
      apiKey: process.env.GROQ_API_KEY,
      model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
      maxRetries: parseInt(process.env.MAX_RETRY_ITERATIONS || "10", 10),
      logger: app.log,
    });

    // -------------------------------------------------------------------------
    // Step 3: Run Autonomous Groq ReAct Loop
    // -------------------------------------------------------------------------
    try {
      app.log.info(`Dispatching autonomous remediation agent for Run #${runId}...`);
      const remediation = await agent.runRemediation({
        errorLogSnippet: extractedWindow,
        branch: headBranch,
        stepName: workflow_run.name || "CI Tests",
        targets: detectedTargets,
        culprit: culpritContext,
      });

      if (tools.modifiedFiles.size === 0) {
        app.log.warn(
          `Remediation loop completed without generating any code patches. Skipping Pull Request creation.`
        );
        return;
      }

      app.log.info(
        `Remediation completed! Modified files: ${Array.from(tools.modifiedFiles.keys()).join(", ")} (Sandbox pass: ${remediation.success})`
      );

      // -----------------------------------------------------------------------
      // Step 4: GitOps - Branch, Commit, and Open PR
      // -----------------------------------------------------------------------
      const gitOps = new GitOpsService(context.octokit, owner, repo);
      const fixBranch = await gitOps.createFixBranch(runId, headBranch);

      const filesMap = Object.fromEntries(tools.modifiedFiles);
      await gitOps.commitFiles(
        fixBranch,
        filesMap,
        `fix(ci): autonomous remediation for run #${runId}\n\n${remediation.rootCause}`
      );

      const prResult = await gitOps.openPullRequest({
        runId,
        headBranch,
        fixBranch,
        rootCause: remediation.rootCause,
        modifiedFiles: remediation.modifiedFiles,
        testCommand: remediation.testCommand,
        testOutput: remediation.testOutput,
        iterations: remediation.iterations,
      });

      app.log.info(`🎉 Successfully opened Pull Request: ${prResult.prUrl} (#${prResult.prNumber})`);
    } catch (remediationError) {
      app.log.error(`Unhandled error during remediation: ${remediationError.message}`);
    } finally {
      await sandbox.cleanup();
    }
  });
}
