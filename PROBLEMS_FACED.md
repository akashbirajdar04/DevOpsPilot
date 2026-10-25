# DevOpsPilot: Problems & Architectural Challenges Log

This document records technical challenges, platform-specific quirks, edge cases, and architectural design decisions encountered during the development of DevOpsPilot, along with the implemented solutions.

---

## 📋 Log of Problems & Implemented Solutions

### Issue #1: Docker Daemon Availability on Host (Windows / Non-Linux Environments)
* **Problem**: Running `docker ps` on the host machine returned `failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine... The system cannot find the file specified.` indicating Docker Desktop is installed but the background daemon is not running or running in a containerized environment without privileged Docker-in-Docker socket access.
* **Impact**: If the sandbox service strictly relies on `docker.from_env()` without fallback, the application and tests would immediately throw `docker.errors.DockerException` and fail to execute.
* **Solution**:
  1. Built an abstraction layer `DockerSandbox` that safely detects whether the Docker daemon is active and responsive via `client.ping()`.
  2. If Docker is available: Launches ephemeral test runs inside containers (`docker run --rm -v ... node:20 / python:3.11`).
  3. If Docker daemon is unavailable: Gracefully falls back to an isolated process runner (`subprocess.run` with restricted environment, cwd confinement, and timeout protections) or a clear mockable sandbox adapter for testing and CI pipelines.
  4. Ensure Docker container execution uses cross-platform path translation (converting Windows backslashes `C:\...` to POSIX mount paths when mounting volumes).

---

### Issue #2: GitHub Webhook Verification & Byte-Exact HMAC Computation
* **Problem**: GitHub delivers raw webhook payloads with `X-Hub-Signature-256`. FastAPI typically parses request bodies into JSON or Pydantic schemas, which consumes the raw bytes stream and can cause HMAC signature verification failures if re-serialized.
* **Impact**: Re-serializing a parsed JSON dict back into bytes for HMAC verification changes whitespace, key ordering, and character escapes, causing signature mismatch and 401 Unauthorized errors.
* **Solution**:
  1. Captured raw `Request.body()` bytes first for cryptographic HMAC-SHA256 comparison against `X-Hub-Signature-256`.
  2. Used `hmac.compare_digest` to prevent timing attacks.
  3. Parsed the verified byte buffer into Pydantic schema `GitHubWebhookPayload`.

---

### Issue #3: Recursive CI Remediation Loop Guard
* **Problem**: If the AI DevOps Engineer creates a fix branch `fix/ci-failure-1234` and opens a PR, that PR will trigger GitHub Actions workflows. If that workflow fails or has tests, GitHub Actions will emit another `workflow_job.completed (failure)` webhook, creating an infinite recursive remediation loop.
* **Impact**: Endless PR creation, API quota exhaustion, and CI pipeline flooding.
* **Solution**:
  1. Implemented a strict pre-filter in `app/api/webhook.py`: check `head_branch` in `workflow_job`.
  2. If branch starts with `fix/ci-` or `fix/remediation-`, immediately ignore the payload with an explicit HTTP 202 response: `"Skipped: Event originates from automated remediation branch."`
  3. Enforced a hard retry ceiling of 3 attempts within any individual remediation session.

---

### Issue #4: GitHub Actions Raw Log Ingestion & Terminal Noise
* **Problem**: GitHub Actions job logs contain copious amounts of ANSI escape sequences (colors, cursor movements, spinner progress bars), timestamp prefixes, and step outputs that can exceed LLM context windows (often tens of thousands of lines).
* **Impact**: High token consumption, potential LLM hallucination, and truncation of the actual root-cause error trace.
* **Solution**:
  1. Stripped ANSI escape sequences using regex `\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])`.
  2. Implemented an intelligent error boundary window parser in `log_parser.py`:
     - Scans for failure markers (`ERR!`, `FAIL`, `Error:`, `Exception:`, `AssertionError`, `ModuleNotFoundError`, `Exit code 1`, `Process completed with exit code`, etc.).
     - Extracts a focused window of 100-150 lines surrounding the root cause (70% context preceding failure, 30% after).
     - Prunes redundant download/cache logs (npm tarball downloads, pip wheels).

---

### Issue #5: Secret Leak Prevention in Generated Patches
* **Problem**: In an autonomous loop, the LLM might attempt to fix authentication issues or API errors by writing placeholder API keys, tokens, or echoing environment variables directly into code.
* **Impact**: Pushing such a branch to origin and opening a PR would leak secrets publicly.
* **Solution**:
  1. Implemented `app/services/security.py` pre-commit secret scanner.
  2. Scanned git diffs / workspace patches against regex rules (AWS keys, GitHub tokens, Generic API keys, private keys, JWTs).
  3. Aborts patch delivery if high-entropy secrets or credential tokens are detected, logging a security breach alert instead of opening a PR.

---

### Issue #6: GitHub Token Character Length Variance in Regex Scanning
* **Problem**: GitHub Personal Access Tokens (Classic and Fine-Grained) vary in exact character length (`ghp_` tokens can be 34 to 40 characters depending on generation era, and `github_pat_` tokens are between 70 to 90 characters). Strict `{36}` fixed-width regexes caused false negatives during secret detection.
* **Impact**: Shorter or longer test tokens slipped past the scanner, failing `test_security.py`.
* **Solution**:
  1. Updated `SECRET_PATTERNS["GitHub Classic Token"]` to `\bghp_[0-9a-zA-Z]{20,40}\b`.
  2. Updated `SECRET_PATTERNS["GitHub Fine-Grained Token"]` to `\bgithub_pat_[0-9a-zA-Z_]{70,90}\b`.
  3. Verified all token varieties are intercepted and cleanly redacted.

---

### Issue #7: Directory Traversal Protection in Autonomous LLM Agent Tools
* **Problem**: When an LLM agent generates arguments for `read_workspace_file` or `write_workspace_file`, malicious prompts or confused models could request paths like `../../etc/passwd` or `../../.env`, reading or overwriting sensitive host files outside the designated workspace.
* **Impact**: Severe security vulnerability allowing arbitrary file access and modification on the host system.
* **Solution**:
  1. Implemented strict path resolution in `WorkspaceTools._resolve_safe_path(relative_path)`.
  2. Stripped leading slashes and resolved the target path against `workspace_path.resolve()`.
  3. Verified `str(target).startswith(str(workspace_path))`, throwing an explicit `ValueError` if any traversal outside the workspace boundary is attempted.
  4. Added comprehensive unit tests in `tests/test_agent.py` to assert directory escape attempts are blocked.

---

### Issue #8: Webhook Timeout Prevention via Async Background Task Dispatch
* **Problem**: GitHub Webhook requests time out if the receiver does not return an HTTP response within 10 seconds. Autonomous diagnosis, sandbox compilation, and test execution can take between 30 and 120 seconds.
* **Impact**: GitHub marks the webhook as timed out / failed and may deactivate the webhook delivery.
* **Solution**:
  1. Decoupled webhook ingestion from remediation execution using FastAPI's `BackgroundTasks`.
  2. The webhook validates signatures and filters in under 5ms, returns an immediate `202 Accepted` with payload `{status: "accepted", remediation_dispatched: true, job_id: ...}`.
  3. The asynchronous background worker fetches logs, executes the agent loop, runs sandbox validation, and opens the PR out-of-band.
