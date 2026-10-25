# HealOps: Problems & Architectural Challenges Log

This document records technical hurdles, runtime nuances, and architectural decisions made while developing the **HealOps** Probot GitHub App Agent.

---

### Issue #1: NPM Package Version Resolution for `@google/genai`
* **Problem**: Attempting to install `@google/genai@^0.1.1` resulted in `npm error notarget No matching version found for @google/genai@^0.1.1` because the official Google GenAI SDK for Node begins at `0.2.0` and latest release is `2.31.0`.
* **Impact**: `npm install` fails during package setup.
* **Solution**: Updated `package.json` to target `"@google/genai": "^2.31.0"`.

---

### Issue #2: GitHub App Infinite Loop Prevention on `workflow_run.completed`
* **Problem**: When HealOps fixes a build and creates a pull request from `fix/ci-failure-<run_id>`, GitHub Actions will trigger another workflow run on that branch. If that run triggers a webhook, HealOps could repeatedly diagnose its own fix branch indefinitely.
* **Impact**: Endless PR creation, API quota depletion, and CI churn.
* **Solution**: Implemented an immediate entrypoint guard in `index.js`:
  ```javascript
  if (workflow_run.head_branch.startsWith("fix/ci-")) {
    app.log.info(`Skipping automated remediation branch: ${workflow_run.head_branch}`);
    return;
  }
  ```

---

### Issue #3: Multi-File Workflow Run Logs vs Single Job Logs
* **Problem**: GitHub's `context.octokit.actions.downloadWorkflowRunLogs` returns a zip archive containing logs for all matrix jobs and workflow steps rather than a single text stream.
* **Impact**: Passing a binary zip buffer directly to an LLM corrupts context and wastes tokens.
* **Solution**: In `src/services/logParser.js`, added extraction logic to decompress the zip archive via `adm-zip` (or fall back to single job text), find the failing step log, strip ANSI escape sequences with `strip-ansi`, and isolate the 150 lines surrounding failure keywords (`FAIL`, `Error:`, `ModuleNotFoundError`, `Exit code 1`).
