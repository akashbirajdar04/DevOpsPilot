# 🩺 HealOps: Autonomous Self-Healing CI/CD GitHub App Agent

**HealOps** is an autonomous GitHub App agent built with **Probot** and powered by **Google Gemini 2.5 Flash**. It automatically intercepts failed GitHub Actions workflow runs, downloads and sanitizes terminal logs, investigates codebases via an agentic function-calling loop, tests patches inside an ephemeral sandbox, and opens verified Pull Requests.

---

## 🏗️ Architecture & Component Flow

```text
[ GitHub Actions Workflow Failure ]
               │
               ▼ (Webhook: workflow_run.completed && failure)
┌─────────────────────────────────────────────────────────────┐
│ 1. Event Router & Safety Guard (index.js)                   │
│    - Verifies Probot webhook signatures                     │
│    - Anti-loop Guard: Skips branches starting with fix/ci- │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. Log Cleaner (src/services/logParser.js)                  │
│    - Strips ANSI sequences with strip-ansi                  │
│    - Extracts focused 150-line failure zone                 │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. Gemini 2.5 Flash Autonomous ReAct Loop                   │
│    (src/agent/diagnoser.js & src/agent/tools.js)            │
│                                                             │
│    Tools:                                                   │
│    - getRepoFile(path)                                      │
│    - applyFilePatch(path, newContent)                       │
│    - runSandboxTest(command)                                │
│                                                             │
│    [Max 3 Retries on Sandbox Failure]                       │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼ (Tests Pass: exitCode === 0)
┌─────────────────────────────────────────────────────────────┐
│ 4. Pre-Commit Security Guardrail (src/utils/secretGuard.js) │
│    - Blocks AWS keys, GitHub tokens, passwords, and .env    │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ 5. GitOps Delivery (src/services/gitOps.js)                 │
│    - Creates fix/ci-failure-<run_id> branch                 │
│    - Commits patched files                                  │
│    - Opens verified Pull Request with test evidence         │
└─────────────────────────────────────────────────────────────┘
```

---

## 📁 Directory Structure

```text
healops/
├── package.json              # Node.js 20+ ESM manifest
├── .env.example              # Environment variables template
├── README.md                 # Documentation and operational runbook
├── index.js                  # Probot app entry point and event router
├── src/
│   ├── agent/
│   │   ├── diagnoser.js      # Gemini LLM function-calling agent loop
│   │   ├── prompts.js        # SRE system prompts and tool schemas
│   │   └── tools.js          # Agent tools (getRepoFile, applyFilePatch, runSandboxTest)
│   ├── services/
│   │   ├── logParser.js      # ANSI stripper and error tail extractor
│   │   ├── sandbox.js        # Ephemeral runner with execa
│   │   └── gitOps.js         # Branch creation, file commit, and PR opener via Octokit
│   └── utils/
│       └── secretGuard.js    # Pre-commit regex scanner for leaked secrets
└── tests/
    └── agent.test.js         # Integration & unit test suite
```

---

## 🚀 Getting Started

### 1. Installation

```bash
cd healops
npm install
```

### 2. Configure Environment

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Fill in your configuration:
- `APP_ID`: Your GitHub App ID.
- `PRIVATE_KEY`: Your GitHub App `.pem` private key string.
- `WEBHOOK_SECRET`: Webhook secret configured on GitHub.
- `GEMINI_API_KEY`: Google AI Studio API key.

### 3. Run the GitHub App

```bash
npm start
```

Probot will launch a local server and provide an automatic Smee.io tunnel URL for testing webhooks directly without manual port forwarding.

---

## 🧪 Testing

Run the automated test suite:

```bash
npm test
```

### Tests Covered:
1. **Secret Scanning**: Verifies AWS keys, GitHub tokens, and `.env` files are blocked from automated commits.
2. **Log Sanitization**: Verifies ANSI escape sequences are stripped and the 150-line failure tail is correctly extracted.
3. **Workspace Tools**: Verifies file reads, writes, patches, and sandboxed command execution.
4. **Integration Simulation**: Simulates a project with a failing build, exercises the ReAct tool-calling loop, fixes the code, validates the repair in the sandbox, and ensures the patch passes secret scanning.
