/**
 * GitOps service: manages branch creation, file commits, and Pull Request generation via Octokit.
 */

import { scanContentForSecrets } from "../utils/secretGuard.js";

/**
 * Formats a descriptive Markdown pull request body.
 */
export function formatPRBody({ runId, rootCause, modifiedFiles, testCommand, testOutput, iterations }) {
  const filesList = modifiedFiles.map((f) => `- \`${f}\``).join("\n") || "- *None*";
  const truncatedLog = testOutput.length > 2000 ? testOutput.slice(-2000) : testOutput;

  return `## 🛠️ HealOps: Automated CI Remediation

**Failed CI Run**: [#${runId}](https://github.com/)  
**Remediation Agent**: HealOps (Powered by Groq)  
**Verification Status**: ✅ Build & Tests Passed in Sandbox (Exit Code: 0)  
**Iterations Used**: ${iterations}  

---

### 🔍 Root-Cause Analysis
${rootCause}

---

### 📝 Files Modified
${filesList}

---

### 🧪 Sandbox Verification Log
**Command Executed:**
\`\`\`bash
${testCommand || "npm test"}
\`\`\`

<details>
<summary>Click to view sandbox verification log</summary>

\`\`\`text
${truncatedLog || "All tests executed successfully."}
\`\`\`
</details>

---

*This pull request was automatically diagnosed, repaired, and sandbox-verified by [HealOps](https://github.com/).*
`;
}

export class GitOpsService {
  /**
   * @param {import("probot").ProbotOctokit} octokit
   * @param {string} owner
   * @param {string} repo
   */
  constructor(octokit, owner, repo) {
    this.octokit = octokit;
    this.owner = owner;
    this.repo = repo;
  }

  /**
   * Check out or create fix branch from the failing head branch ref.
   * @param {number|string} runId
   * @param {string} headBranch
   * @returns {Promise<string>} Created branch name
   */
  async createFixBranch(runId, headBranch) {
    const fixBranch = `fix/ci-failure-${runId}`;

    // Get the latest commit SHA of the failing head branch
    const { data: refData } = await this.octokit.rest.git.getRef({
      owner: this.owner,
      repo: this.repo,
      ref: `heads/${headBranch}`,
    });
    const latestCommitSha = refData.object.sha;

    // Check if the branch already exists; if not, create it
    try {
      await this.octokit.rest.git.getRef({
        owner: this.owner,
        repo: this.repo,
        ref: `heads/${fixBranch}`,
      });
      // Branch exists, update it to latestCommitSha
      await this.octokit.rest.git.updateRef({
        owner: this.owner,
        repo: this.repo,
        ref: `heads/${fixBranch}`,
        sha: latestCommitSha,
        force: true,
      });
    } catch {
      // Branch does not exist, create it
      await this.octokit.rest.git.createRef({
        owner: this.owner,
        repo: this.repo,
        ref: `refs/heads/${fixBranch}`,
        sha: latestCommitSha,
      });
    }

    return fixBranch;
  }

  /**
   * Commit a map of modified files to the fix branch after passing secret scans.
   * @param {string} branch
   * @param {Record<string, string>} filesMap - { filePath: fileContent }
   * @param {string} commitMessage
   */
  async commitFiles(branch, filesMap, commitMessage) {
    for (const [filePath, content] of Object.entries(filesMap)) {
      // Secret scanning guardrail
      const scanResult = scanContentForSecrets(content, filePath);
      if (!scanResult.passed) {
        throw new Error(
          `Secret security guardrail blocked commit to '${filePath}': ${scanResult.violations.join(", ")}`
        );
      }

      // Check if file already exists in branch to get its blob SHA
      let fileSha;
      try {
        const { data } = await this.octokit.rest.repos.getContent({
          owner: this.owner,
          repo: this.repo,
          path: filePath,
          ref: branch,
        });
        if (!Array.isArray(data)) {
          fileSha = data.sha;
        }
      } catch {
        fileSha = undefined;
      }

      await this.octokit.rest.repos.createOrUpdateFileContents({
        owner: this.owner,
        repo: this.repo,
        path: filePath,
        message: commitMessage,
        content: Buffer.from(content, "utf-8").toString("base64"),
        branch,
        sha: fileSha,
      });
    }
  }

  /**
   * Open Pull Request from fix branch to headBranch.
   * @param {object} params
   * @returns {Promise<{ prUrl: string, prNumber: number }>}
   */
  async openPullRequest({ runId, headBranch, fixBranch, rootCause, modifiedFiles, testCommand, testOutput, iterations, report = null, customBody = null }) {
    const title = `fix(ci): automated remediation for failed run #${runId}`;
    const body = customBody || (report?.toPRMarkdown ? report.toPRMarkdown() : formatPRBody({
      runId,
      rootCause,
      modifiedFiles,
      testCommand,
      testOutput,
      iterations,
    }));

    // Check if PR already exists
    const { data: existingPRs } = await this.octokit.rest.pulls.list({
      owner: this.owner,
      repo: this.repo,
      head: `${this.owner}:${fixBranch}`,
      base: headBranch,
      state: "open",
    });

    if (existingPRs.length > 0) {
      const pr = existingPRs[0];
      await this.octokit.rest.pulls.update({
        owner: this.owner,
        repo: this.repo,
        pull_number: pr.number,
        title,
        body,
      });
      return { prUrl: pr.html_url, prNumber: pr.number };
    }

    const { data: pr } = await this.octokit.rest.pulls.create({
      owner: this.owner,
      repo: this.repo,
      title,
      body,
      head: fixBranch,
      base: headBranch,
    });

    return { prUrl: pr.html_url, prNumber: pr.number };
  }

  /**
   * Leave an audit comment on a commit when remediation aborts.
   * @param {string} commitSha
   * @param {string} commentBody
   * @returns {Promise<any>}
   */
  async createCommitComment(commitSha, commentBody) {
    if (!commitSha || !this.octokit?.rest?.repos?.createCommitComment) return null;
    try {
      const response = await this.octokit.rest.repos.createCommitComment({
        owner: this.owner,
        repo: this.repo,
        commit_sha: commitSha,
        body: commentBody,
      });
      return response.data;
    } catch (err) {
      return null;
    }
  }
}
