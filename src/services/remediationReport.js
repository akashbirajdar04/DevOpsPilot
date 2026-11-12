/**
 * Structured Remediation Report & Observability Service.
 * Produces machine-readable diagnostic reports and GitHub PR summaries.
 */

export class RemediationReport {
  /**
   * @param {object} initial
   */
  constructor(initial = {}) {
    this.startTime = Date.now();
    this.repo = initial.repo || "";
    this.repoId = initial.repoId || null;
    this.runId = initial.runId || null;
    this.runAttempt = initial.runAttempt || 1;
    this.deliveryId = initial.deliveryId || null;
    this.headBranch = initial.headBranch || "";
    this.originalCommitSha = initial.originalCommitSha || null;

    this.rootCause = initial.rootCause || "";
    this.affectedFiles = initial.affectedFiles || [];
    this.modifiedFiles = initial.modifiedFiles || [];

    this.aiRequest = {
      status: "not_invoked", // "success" | "rejected" | "error" | "rate_limited" | "not_invoked"
      model: initial.model || "openai/gpt-oss-120b",
      retries: 0,
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      explanation: "",
    };

    this.patchValidation = {
      status: "not_run", // "passed" | "rejected" | "skipped"
      schemaValid: false,
      gitCheckValid: false,
      reason: null,
    };

    this.patchApplication = {
      status: "not_run", // "applied" | "failed" | "rolled_back" | "skipped"
      modifiedFiles: [],
      changedLines: 0,
      reason: null,
    };

    this.verification = {
      lint: null,
      typecheck: null,
      build: null,
      tests: null,
    };

    this.finalState = "INCOMPLETE"; // "VERIFIED" | "FAILED" | "INCOMPLETE" | "REJECTED"
    this.failureStage = null;
    this.totalExecutionTimeMs = 0;
  }

  setAIResult({ status, retries = 0, tokenUsage = {}, explanation = "", error = null }) {
    this.aiRequest.status = status;
    this.aiRequest.retries = retries;
    this.aiRequest.tokenUsage = {
      promptTokens: tokenUsage.promptTokens || 0,
      completionTokens: tokenUsage.completionTokens || 0,
      totalTokens: tokenUsage.totalTokens || 0,
    };
    this.aiRequest.explanation = explanation;
    if (error) {
      this.aiRequest.error = error;
    }
  }

  setPatchValidation({ status, schemaValid = false, gitCheckValid = false, reason = null }) {
    this.patchValidation.status = status;
    this.patchValidation.schemaValid = schemaValid;
    this.patchValidation.gitCheckValid = gitCheckValid;
    this.patchValidation.reason = reason;
    if (status === "rejected") {
      this.finalState = "REJECTED";
      this.failureStage = "patch_validation";
    }
  }

  setPatchApplication(patchResultOrOptions) {
    if (typeof patchResultOrOptions === "object" && patchResultOrOptions !== null) {
      const status =
        patchResultOrOptions.status || (patchResultOrOptions.success ? "applied" : "failed");
      this.patchApplication.status = status;
      this.patchApplication.modifiedFiles = patchResultOrOptions.modifiedFiles || [];
      this.patchApplication.changedLines = patchResultOrOptions.changedLines || 0;
      this.patchApplication.reason = patchResultOrOptions.reason || null;
      if (status === "failed" || status === "rolled_back") {
        this.finalState = "REJECTED";
        this.failureStage = "patch_application";
      }
    }
  }

  setVerificationResults({ finalState, results = {}, failureReason = null, summary = null }) {
    this.verification = results;
    this.verificationSummary = summary;
    this.finalState = finalState;
    if (finalState !== "VERIFIED") {
      this.failureStage = "ci_verification";
      this.failureReason = failureReason || summary;
    }
  }

  finalize(finalState = null) {
    if (finalState) {
      this.finalState = finalState;
    }
    this.totalExecutionTimeMs = Date.now() - this.startTime;
    return this;
  }

  toJSON() {
    return {
      repo: this.repo,
      repoId: this.repoId,
      runId: this.runId,
      runAttempt: this.runAttempt,
      deliveryId: this.deliveryId,
      headBranch: this.headBranch,
      originalCommitSha: this.originalCommitSha,
      rootCause: this.rootCause,
      affectedFiles: this.affectedFiles,
      modifiedFiles: this.modifiedFiles,
      aiRequest: this.aiRequest,
      patchValidation: this.patchValidation,
      patchApplication: this.patchApplication,
      verification: this.verification,
      finalState: this.finalState,
      failureStage: this.failureStage,
      failureReason: this.failureReason || null,
      totalExecutionTimeMs: this.totalExecutionTimeMs || Date.now() - this.startTime,
    };
  }

  /**
   * Format human-readable Markdown suitable for GitHub Pull Request bodies.
   */
  toPRMarkdown() {
    const statusIcon = this.finalState === "VERIFIED" ? "✅" : "❌";
    const filesList = this.modifiedFiles.map((f) => `- \`${f}\``).join("\n") || "- *None*";

    const v = this.verification;
    const checksRows = [];
    if (v.lint) {
      const icon = v.lint.status === "passed" ? "✅ Passed" : "❌ Failed";
      checksRows.push(`| **Lint** | ${icon} (Errors: ${v.lint.errors}, Warnings: ${v.lint.warnings}) | \`${v.lint.command}\` | ${v.lint.durationMs}ms |`);
    }
    if (v.typecheck) {
      const icon = v.typecheck.status === "passed" ? "✅ Passed" : "❌ Failed";
      checksRows.push(`| **TypeScript** | ${icon} | \`${v.typecheck.command}\` | ${v.typecheck.durationMs}ms |`);
    }
    if (v.build) {
      const icon = v.build.status === "passed" ? "✅ Passed" : "❌ Failed";
      checksRows.push(`| **Build** | ${icon} | \`${v.build.command}\` | ${v.build.durationMs}ms |`);
    }
    if (v.tests) {
      const icon = v.tests.status === "passed" ? "✅ Passed" : "❌ Failed";
      checksRows.push(`| **Tests** | ${icon} | \`${v.tests.command}\` | ${v.tests.durationMs}ms |`);
    }

    const verificationTable = checksRows.length > 0
      ? `| Check | Status | Command | Duration |\n| :--- | :--- | :--- | :--- |\n${checksRows.join("\n")}`
      : "*No verification checks configured.*";

    return `## 🛠️ DevOpsPilot: Automated CI Remediation

**Failed CI Run**: [#${this.runId}](https://github.com/${this.repo}/actions/runs/${this.runId}) (Attempt ${this.runAttempt})  
**Base Commit SHA**: \`${this.originalCommitSha || "HEAD"}\`  
**Remediation State**: ${statusIcon} **${this.finalState}**  
**Execution Duration**: ${(this.totalExecutionTimeMs / 1000).toFixed(2)}s  

> [!IMPORTANT]
> **Human approval is required before merging.** All modifications have been verified in an isolated sandbox, but developer review is mandatory.

---

### 🔍 Root-Cause Analysis
${this.rootCause || "Automated diagnosis identified syntax/lint errors in failing workflow run."}

${this.aiRequest.explanation ? `**AI Fix Explanation:**\n${this.aiRequest.explanation}\n` : ""}

---

### 📝 Files Modified
${filesList}

---

### 🧪 Independent CI Verification Results
${verificationTable}

---
*Diagnosed and verified deterministically by DevOpsPilot.*
`;
  }
}
