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

---

### Issue #4: Probot Manifest Setup Wizard Fails with 'Invalid GitHub App configuration'
* **Problem**: Clicking 'Register a GitHub App' in Probot forwarded an incomplete manifest to GitHub (`https://github.com/settings/apps/new?manifest=...`), missing the mandatory `url` field and `default_permissions` / `default_events` specifications.
* **Impact**: GitHub rejected the manifest registration with a red banner error: `Invalid GitHub App configuration`.
* **Solution**:
  1. Created [app.yml](file:///c:/DevOpsPilot/app.yml) in root defining the required `name`, `url`, `default_permissions` (`actions: read`, `checks: read`, `contents: write`, `pull_requests: write`), and `default_events` (`workflow_run`).
  2. Added `"homepage"` and `"repository"` fields to [package.json](file:///c:/DevOpsPilot/package.json).
  3. Restarting `npm start` and clicking 'Register a GitHub App' now passes all GitHub manifest validations.

---

### Issue #5: GitHub Rejects Manifest with 'Hook url is not supported (localhost)'
* **Problem**: GitHub webhooks are delivered over the public internet and cannot route to `http://localhost:3000/`. When Probot does not have a public `WEBHOOK_PROXY_URL` configured, it defaults to `http://localhost:3000/`, which GitHub's manifest API rejects with `"Error Hook url is not supported because it isn't reachable over the public Internet (localhost)"`.
* **Impact**: Setup wizard cannot proceed past GitHub's manifest validation.
* **Solution**:
  1. Created a dedicated Smee.io webhook channel: `https://smee.io/G5XSYBSml7CPCF7d`.
  2. Configured `WEBHOOK_PROXY_URL=https://smee.io/G5XSYBSml7CPCF7d` in [.env](file:///c:/DevOpsPilot/.env) and in [app.yml](file:///c:/DevOpsPilot/app.yml) under `hook_attributes.url`.
  3. Smee proxies all public GitHub webhook events directly to your local development instance.

---

### Issue #6: Missing `smee-client` Dependency Disables Webhook Forwarding
* **Problem**: Probot requires `smee-client` to connect to `WEBHOOK_PROXY_URL`. Without `smee-client` installed, Probot silently logged `WARN (server): Run npm install --save-dev smee-client to proxy webhooks to localhost` and did not connect to Smee.
* **Impact**: GitHub sent webhooks to Smee successfully, but no events reached the local Probot server on localhost.
* **Solution**: Installed `smee-client` via `npm install smee-client`. Probot now logs `Connected to https://smee.io/...` and `Forwarding to http://localhost:3000/api/github/webhooks`.

---

### Issue #7: `gemini-2.5-flash` Model Deprecation (`404 NOT_FOUND`)
* **Problem**: The agent defaulted to `gemini-2.5-flash` when `GEMINI_MODEL` was unspecified. Google AI Studio deprecated `models/gemini-2.5-flash`, returning `404 NOT_FOUND`.
* **Impact**: When a failure occurred, the agent crashed instantly during `generateContent`, aborting before remediation.
* **Solution**: Updated `.env` and default fallbacks in `src/agent/diagnoser.js` and `index.js` to `gemini-3.5-flash`.

---

### Issue #8: Empty Ephemeral Sandbox Workspace
* **Problem**: `sandbox.initWorkspace()` only created an empty temporary directory (`os.tmpdir()/healops-sandbox-XXXX`), so `runSandboxTest` failed immediately due to missing repository files and dependencies.
* **Impact**: Sandbox verification failed with exit code 1, causing the agent to drop the fix and skip opening a PR.
* **Solution**: Added authenticated shallow clone (`git clone --depth 1 --branch <branch>`) into the sandbox workspace using the GitHub App's installation token, ensuring test commands have access to the actual project files.

---

### Issue #9: Gemini API 503 / High Demand Spikes
* **Problem**: During high-traffic periods, Google AI Studio intermittently returns `503 UNAVAILABLE: "This model is currently experiencing high demand. Spikes in demand are usually temporary."`.
* **Impact**: The remediation loop crashed on iteration 3 when the temporary spike hit.
* **Solution**: Added `_generateContentWithRetry()` with progressive exponential backoff (3s, 4.5s, 6.75s, up to 4 attempts).

---

### Issue #10: Low Iteration Ceiling (3 Retries) Exhausted During Multi-File Exploration
* **Problem**: In projects with nested subdirectories (e.g. `frontend/`), the agent used all 3 iterations inspecting configuration files (`package.json`, `frontend/package.json`, `frontend/eslint.config.js`) before it had a chance to apply the fix.
* **Impact**: Agent reached the 3-iteration limit without generating patches (`tools.modifiedFiles.size === 0`).
* **Solution**: Increased `MAX_RETRY_ITERATIONS` to `8` in [.env](file:///c:/DevOpsPilot/.env) and code defaults, and instructed the agent to prioritize inspecting the failing source files directly.

---

### Issue #11: Pull Request Creation Fails with 'No commits between main and fix/...'
* **Problem**: If `runSandboxTest` exited with code 0 before any code was modified (e.g. executing a command that passed in the root directory), `diagnoser.js` exited early with `success: true` despite `tools.modifiedFiles` being empty. Attempting to create a Pull Request with zero commit differences caused GitHub's API to reject the request with `Validation Failed: No commits between main and fix/...`.
* **Impact**: Unhandled crash during PR generation when no files were changed.
* **Solution**:
  1. Updated `diagnoser.js` to strictly require `this.tools.modifiedFiles.size > 0` before accepting verification success.
  2. Enhanced `runSandboxTest` to append a warning notice if test commands pass before code patches are applied.
  3. Added an explicit guard in `index.js` to abort PR creation gracefully if `tools.modifiedFiles.size === 0`.

---

### Issue #12: Groq 8,000 TPM Rate Limit Exceeded on Large Multi-File Dumps
* **Problem**: On Groq's on-demand free tier, requests are limited to 8,000 Tokens Per Minute (TPM). When `AdminDashboard.jsx` was retrieved, the cumulative conversation payload reached 11,099 tokens, triggering HTTP 413.
* **Impact**: The remediation loop crashed on iteration 3 with `Request too large on tokens per minute (TPM)`.
* **Solution**:
  1. Capped `getRepoFile` output to 5,000 characters to prevent any single file from blowing through token budgets.
  2. Added `_pruneGroqMessages()` to automatically compress older intermediate tool calls in `messages` history to stay under 12,000 characters (~3,000 tokens).
  3. Added retry backoff on 413/429 errors to pause and re-prune context before retrying.

---

### Issue #13: Complete Gemini Decommissioning & Groq Llama-3.3-70B Model Orchestration
* **Problem**: Gemini quota limits (daily token caps and frequent 503 high-demand spikes) caused remediation downtime. Legacy Gemini code and mock references remained across the app.
* **Impact**: The user requested complete elimination of Gemini in favor of Groq with `llama-3.3-70b-versatile`.
* **Solution**:
  1. Completely uninstalled `@google/genai` and wiped all Gemini references from `.env`, `index.js`, `diagnoser.js`, `gitOps.js`, `prompts.js`, and test suites.
  2. Configured `GROQ_MODEL=llama-3.3-70b-versatile` with an automatic resilience fallback to `openai/gpt-oss-120b` in `diagnoser.js` if the API key's organization tier lacks access to the Llama 3.3 model.
  3. Re-architected `tests/agent.test.js` to mock Groq completions (`agent.groq.chat.completions.create`), verifying 4/4 passing tests.
