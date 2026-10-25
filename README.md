# 🚀 DevOpsPilot: Self-Healing CI/CD Autonomous Agent

**DevOpsPilot** is an autonomous self-healing CI/CD agent designed to ingest GitHub Actions webhook failure events, strip and parse noisy terminal logs down to the root cause, isolate repositories in safe workspaces, execute iterative repair loops powered by Google GenAI (Gemini 2.5 Flash), validate patches inside ephemeral sandboxes, and automatically open verified GitHub Pull Requests.

---

## 🏗️ Architecture Overview

```text
+----------------------------------------+
| GitHub Actions Pipeline / Webhook Emit |
+-------------------+--------------------+
                    |
       HTTP POST    | (Event: workflow_job.completed && failure)
                    v
+---------------------------------------------------------------------------------------+
|  Auto-Remediation Service (FastAPI Daemon)                                            |
|                                                                                       |
|  +-----------------------+      +---------------------+      +---------------------+  |
|  | Webhook Ingestion     | ---> | Log Ingestion &     | ---> | Repository Context  |  |
|  | - HMAC verification   |      | Noise Pruning       |      | Cloner              |  |
|  | - Event de-duplication|      | - ANSI strip / Tail |      | - Git worktree sync |  |
|  +-----------------------+      +---------------------+      +----------+----------+  |
|                                                                         |             |
|  +--------------------------------------------------------------------+ |             |
|  | LLM Agentic Remediation Engine (Gemini 2.5 Flash / Function Calling) | v             |
|  |                                                                                    |
|  |   +-------------------+         +---------------------+                            |
|  |   | Diagnosis Module  | <-----> | Tool Registry       |                            |
|  |   | (Gemini 2.5 Flash)|         | - read_file         |                            |
|  |   +---------+---------+         | - apply_patch       |                            |
|  |             |                   | - run_sandbox_build |                            |
|  |             v                   +----------+----------+                            |
|  |   [Is Fix Verified?]                       |                                       |
|  |       |               \                    v                                       |
|  |     Yes                No (Retry <= 3) -> Ephemeral Docker Sandbox                 |
|  |       |                                                                            |
|  |       v                                                                            |
|  |   +------------------------------------+                                           |
|  |   | Git Patch & PR Delivery Engine     |                                           |
|  |   | - Gitleaks Secret Redaction        |                                           |
|  |   | - Push to fix/ci-<run-id> branch   |                                           |
|  |   | - Open GitHub Pull Request via API |                                           |
|  |   +------------------------------------+                                           |
+---------------------------------------------------------------------------------------+
```

---

## 📁 Repository Structure

```text
DevOpsPilot/
├── app/
│   ├── __init__.py
│   ├── main.py                  # FastAPI entrypoint, logging, and health checks
│   ├── config.py                # Pydantic Settings configuration
│   ├── api/
│   │   ├── __init__.py
│   │   └── webhook.py           # Webhook receiver with HMAC and loop guards
│   ├── services/
│   │   ├── github_client.py     # GitHub REST API: logs download & PR delivery
│   │   ├── log_parser.py        # ANSI code stripper & failure window extractor
│   │   ├── sandbox.py           # Workspace manager & Docker sandbox runner
│   │   └── security.py          # Pre-commit secret scanning engine (Gitleaks)
│   ├── agent/
│   │   ├── __init__.py
│   │   ├── core.py              # Agentic loop finite state machine
│   │   ├── prompts.py           # SRE root-cause diagnosis system prompts
│   │   └── tools.py             # Tool implementations with sandbox safety
│   └── models/
│       ├── __init__.py
│       └── schema.py            # Pydantic schemas for events, tools, and PRs
├── tests/
│   ├── test_log_parser.py       # Log parsing & ANSI cleaner tests
│   ├── test_security.py         # Secret scanner tests
│   ├── test_sandbox.py          # Sandbox & workspace tests
│   ├── test_agent.py            # Agent tools & security tests
│   ├── test_webhook.py          # Webhook HMAC and filter tests
│   └── test_e2e_remediation.py  # Full end-to-end self-healing simulation test
├── Dockerfile                   # Container definition
├── requirements.txt             # Pinned project dependencies
├── .env.example                 # Template environment variables
├── PROGRESS.md                  # Milestone progress tracking
└── PROBLEMS_FACED.md            # Technical challenges & solutions log
```

---

## ⚡ Quick Start

### 1. Environment Configuration
Clone the repository and set up your `.env` file:

```bash
cp .env.example .env
```

Configure your credentials in `.env`:
- `GITHUB_TOKEN`: GitHub Personal Access Token (with `repo` permissions).
- `GITHUB_WEBHOOK_SECRET`: Secret key configured on your GitHub Webhook.
- `GEMINI_API_KEY`: Google Gemini API key.

### 2. Local Setup & Virtual Environment

```bash
# Create virtual environment
python -m venv .venv

# Activate virtual environment (Windows PowerShell)
.venv\Scripts\Activate.ps1
# On Linux/macOS: source .venv/bin/activate

# Install dependencies
pip install -r requirements.txt
```

### 3. Run the Development Server

```bash
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

Visit the interactive OpenAPI documentation at: `http://localhost:8000/docs`.

---

## 🧪 Running Tests

DevOpsPilot features 100% passing unit, integration, and E2E simulation tests:

```bash
pytest -v
```

---

## 🛡️ Guardrails & Safety Mechanisms

1. **Anti-Infinite Loop Guard**:
   Events triggered by branches matching `fix/ci-*` or `fix/remediation-*` are immediately rejected with an HTTP 202 to avoid recursive CI self-healing triggers.
2. **Pre-Commit Secret Scanning**:
   Before creating git commits or opening PRs, all patches pass through `SecretScanner` to intercept AWS keys, GitHub tokens, private keys, or credentials.
3. **Sandbox Directory Traversal Prevention**:
   All agent file read/write operations strictly enforce boundary checks (`_resolve_safe_path`), blocking directory escape (`../../`).
4. **Retry Budget**:
   A strict hard ceiling of 3 iterative repair attempts per job prevents runaway LLM execution.
