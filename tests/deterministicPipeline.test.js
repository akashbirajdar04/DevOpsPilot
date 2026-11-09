/**
 * Automated Regression Test Suite for DevOpsPilot Reliable Deterministic Pipeline
 * Covers all 18 critical scenarios required for production safety and determinism.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execa } from "execa";

import {
  parseAndValidatePatchResponse,
  isValidUnifiedDiff,
  normalizeJsonFences,
} from "../src/agent/patchSchema.js";
import { GitPatchApplier, isProtectedFile } from "../src/agent/gitPatchApplier.js";
import { CIVerifier, detectProjectChecks } from "../src/services/ciVerifier.js";
import { GroqRemediationClient, extractRetryAfterMs } from "../src/agent/groqClient.js";
import { RunLock } from "../src/utils/runLock.js";
import { DiagnoserAgent } from "../src/agent/diagnoser.js";
import { AgentTools } from "../src/agent/tools.js";
import { Sandbox } from "../src/services/sandbox.js";

// Helper: initialize temporary git workspace with a committed file
async function createGitWorkspace(fileName, initialContent) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "healops-git-ws-"));
  await execa("git", ["init"], { cwd: dir });
  await execa("git", ["config", "user.name", "DevOpsPilot"], { cwd: dir });
  await execa("git", ["config", "user.email", "pilot@devops.internal"], { cwd: dir });

  const filePath = path.join(dir, fileName);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, initialContent, "utf-8");

  await execa("git", ["add", "."], { cwd: dir });
  await execa("git", ["commit", "-m", "initial commit"], { cwd: dir });

  const { stdout: commitSha } = await execa("git", ["rev-parse", "HEAD"], { cwd: dir });

  return {
    dir,
    filePath,
    commitSha: commitSha.trim(),
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

// ---------------------------------------------------------------------------
// Scenario 1: Valid structured AI response
// ---------------------------------------------------------------------------
test("Scenario 1: Valid structured AI response passes Zod schema and diff validation", () => {
  const rawResponse = JSON.stringify({
    status: "fix_proposed",
    file: "frontend/src/App.jsx",
    fix_type: "syntax_error",
    patch: "@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;",
    explanation: "Corrected constant assignment",
  });

  const result = parseAndValidatePatchResponse(rawResponse, {
    expectedFile: "frontend/src/App.jsx",
  });

  assert.equal(result.valid, true);
  assert.equal(result.data.status, "fix_proposed");
  assert.equal(result.data.file, "frontend/src/App.jsx");
  assert.equal(result.data.fix_type, "syntax_error");
  assert.match(result.data.patch, /@@ -1,2 \+1,2 @@/);
});

// ---------------------------------------------------------------------------
// Scenario 2: Invalid JSON response
// ---------------------------------------------------------------------------
test("Scenario 2: Invalid JSON response is rejected cleanly with descriptive error", () => {
  const rawResponse = '```json\n{ "status": "fix_proposed", broken json here...\n```';

  const result = parseAndValidatePatchResponse(rawResponse);
  assert.equal(result.valid, false);
  assert.match(result.reason, /Invalid JSON received from AI/i);
});

// ---------------------------------------------------------------------------
// Scenario 3: Missing required JSON fields
// ---------------------------------------------------------------------------
test("Scenario 3: Missing required JSON fields fails schema validation", () => {
  const missingPatch = JSON.stringify({
    status: "fix_proposed",
    file: "src/index.js",
    fix_type: "linter_rule",
    // patch is missing
    explanation: "Missing patch field",
  });

  const result = parseAndValidatePatchResponse(missingPatch);
  assert.equal(result.valid, false);
  assert.match(result.reason, /Schema validation failed.*patch/i);
});

// ---------------------------------------------------------------------------
// Scenario 4: Empty patch
// ---------------------------------------------------------------------------
test("Scenario 4: Empty patch for 'fix_proposed' status is rejected", () => {
  const emptyPatch = JSON.stringify({
    status: "fix_proposed",
    file: "src/index.js",
    fix_type: "syntax_error",
    patch: "   ",
    explanation: "No changes",
  });

  const result = parseAndValidatePatchResponse(emptyPatch);
  assert.equal(result.valid, false);
  assert.match(result.reason, /Empty patch received/i);
});

// ---------------------------------------------------------------------------
// Scenario 5: Malformed unified diff
// ---------------------------------------------------------------------------
test("Scenario 5: Malformed unified diff missing hunk headers is rejected", () => {
  const malformed = JSON.stringify({
    status: "fix_proposed",
    file: "src/index.js",
    fix_type: "logic_error",
    patch: "just some random code without hunk markers\nlet x = 10;",
    explanation: "Invalid diff structure",
  });

  const result = parseAndValidatePatchResponse(malformed);
  assert.equal(result.valid, false);
  assert.match(result.reason, /not a valid unified diff/i);
});

// ---------------------------------------------------------------------------
// Scenario 6: Patch targeting an unauthorized file or path traversal
// ---------------------------------------------------------------------------
test("Scenario 6: Patch targeting unauthorized file or directory traversal is blocked", () => {
  // Test directory traversal
  const traversal = JSON.stringify({
    status: "fix_proposed",
    file: "../secret.env",
    fix_type: "syntax_error",
    patch: "@@ -1 +1 @@\n-a\n+b",
    explanation: "attempt escape",
  });
  const res1 = parseAndValidatePatchResponse(traversal);
  assert.equal(res1.valid, false);
  assert.match(res1.reason, /Security violation/i);

  // Test target file mismatch
  const mismatch = JSON.stringify({
    status: "fix_proposed",
    file: "src/Other.jsx",
    fix_type: "syntax_error",
    patch: "@@ -1 +1 @@\n-a\n+b",
    explanation: "wrong target",
  });
  const res2 = parseAndValidatePatchResponse(mismatch, { expectedFile: "src/App.jsx" });
  assert.equal(res2.valid, false);
  assert.match(res2.reason, /Target file mismatch/i);

  // Test protected file check
  assert.equal(isProtectedFile(".github/workflows/ci.yml"), true);
  assert.equal(isProtectedFile("package-lock.json"), true);
  assert.equal(isProtectedFile(".env.local"), true);
});

// ---------------------------------------------------------------------------
// Scenario 7: Patch application failure (git apply check fails)
// ---------------------------------------------------------------------------
test("Scenario 7: Non-matching patch fails git apply check without touching workspace", async () => {
  const ws = await createGitWorkspace("calc.js", "function add(a, b) {\n  return a + b;\n}\n");
  try {
    const applier = new GitPatchApplier({ workspaceDir: ws.dir });
    await applier.recordOriginalCommit();

    // Patch attempts to replace code that does not exist in calc.js
    const badPatch = "@@ -10,2 +10,2 @@\n-const nonExistent = 100;\n+const nonExistent = 200;";
    const result = await applier.applyPatch({
       patchText: badPatch,
       targetFile: "calc.js",
       allowedFiles: ["calc.js"],
    });

    assert.equal(result.success, false);
    assert.match(result.reason, /Git patch validation.*failed/i);

    // Verify file remains identical
    const content = await fs.readFile(ws.filePath, "utf-8");
    assert.equal(content, "function add(a, b) {\n  return a + b;\n}\n");
  } finally {
    await ws.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Scenario 8: Successful patch application
// ---------------------------------------------------------------------------
test("Scenario 8: Valid unified diff applies cleanly via git apply and inspects diff", async () => {
  const ws = await createGitWorkspace("calc.js", "function add(a, b) {\n  return a - b;\n}\n");
  try {
    const applier = new GitPatchApplier({ workspaceDir: ws.dir });
    await applier.recordOriginalCommit();

    const validPatch = "@@ -1,3 +1,3 @@\n function add(a, b) {\n-  return a - b;\n+  return a + b;\n }";
    const result = await applier.applyPatch({
      patchText: validPatch,
      targetFile: "calc.js",
      allowedFiles: ["calc.js"],
    });

    assert.equal(result.success, true);
    assert.deepEqual(result.modifiedFiles, ["calc.js"]);
    assert.match(result.diff, /\+  return a \+ b;/);

    const updated = await fs.readFile(ws.filePath, "utf-8");
    assert.equal(updated.replace(/\r\n/g, "\n"), "function add(a, b) {\n  return a + b;\n}\n");
  } finally {
    await ws.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Scenario 9: ESLint failure
// ---------------------------------------------------------------------------
test("Scenario 9: ESLint failure isolates errors and classifies outcome as FAILED", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "healops-lint-fail-"));
  try {
    const verifier = new CIVerifier({ workspaceDir: tempDir });

    const explicitChecks = {
      lint: {
        command: 'node -e "console.log(JSON.stringify([{ filePath: \'app.js\', messages: [{ ruleId: \'no-undef\', severity: 2, message: \'x is not defined\', line: 1, column: 1 }] }])); process.exit(1);"',
        cwd: tempDir,
      },
    };

    const result = await verifier.runVerification({ explicitChecks });
    assert.equal(result.finalState, "FAILED");
    assert.equal(result.results.lint.status, "failed");
    assert.equal(result.results.lint.errors, 1);
    assert.match(result.summary, /Lint check failed with 1 error/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Scenario 10: Build failure
// ---------------------------------------------------------------------------
test("Scenario 10: Build failure sets finalState to FAILED", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "healops-build-fail-"));
  try {
    const verifier = new CIVerifier({ workspaceDir: tempDir });

    const explicitChecks = {
      build: {
        command: 'node -e "console.error(\'Vite build error: syntax error\'); process.exit(1);"',
        cwd: tempDir,
      },
    };

    const result = await verifier.runVerification({ explicitChecks });
    assert.equal(result.finalState, "FAILED");
    assert.equal(result.results.build.status, "failed");
    assert.equal(result.results.build.exitCode, 1);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Scenario 11: Test failure
// ---------------------------------------------------------------------------
test("Scenario 11: Test suite failure sets finalState to FAILED", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "healops-test-fail-"));
  try {
    const verifier = new CIVerifier({ workspaceDir: tempDir });

    const explicitChecks = {
      tests: {
        command: 'node -e "console.error(\'AssertionError: 1 !== 2\'); process.exit(1);"',
        cwd: tempDir,
      },
    };

    const result = await verifier.runVerification({ explicitChecks });
    assert.equal(result.finalState, "FAILED");
    assert.equal(result.results.tests.status, "failed");
    assert.equal(result.results.tests.exitCode, 1);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Scenario 12: Missing verification command
// ---------------------------------------------------------------------------
test("Scenario 12: Missing verification command marks state as INCOMPLETE", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "healops-no-scripts-"));
  try {
    // Write package.json with NO scripts
    await fs.writeFile(path.join(tempDir, "package.json"), JSON.stringify({ name: "empty-pkg" }), "utf-8");

    const verifier = new CIVerifier({ workspaceDir: tempDir });
    const result = await verifier.runVerification();

    assert.equal(result.finalState, "INCOMPLETE");
    assert.match(result.failureReason, /Missing verification command/i);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Scenario 13: Groq HTTP 429 response handled with backoff & retry
// ---------------------------------------------------------------------------
test("Scenario 13: Groq HTTP 429 response triggers backoff and succeeds on retry", async () => {
  const client = new GroqRemediationClient({
    apiKey: "mock-key",
    model: "openai/gpt-oss-120b",
    maxRetries: 3,
    baseDelayMs: 20, // fast delay for unit test
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });

  let calls = 0;
  client.groq = {
    chat: {
      completions: {
        create: async () => {
          calls++;
          if (calls === 1) {
            const err = new Error("Rate limit reached. Please try again in 50ms");
            err.status = 429;
            throw err;
          }
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    status: "fix_proposed",
                    file: "src/App.jsx",
                    fix_type: "syntax_error",
                    patch: "@@ -1 +1 @@\n-const a = 1;\n+const a = 2;",
                    explanation: "Retry succeeded",
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 120, completion_tokens: 45, total_tokens: 165 },
          };
        },
      },
    },
  };

  const res = await client.requestStructuredPatch({
    targetFile: "src/App.jsx",
    errorDetails: "SyntaxError",
    codeContext: "const a = 1;",
  });

  assert.equal(res.success, true);
  assert.equal(res.retries, 1);
  assert.equal(res.tokenUsage.totalTokens, 165);
  assert.equal(res.data.status, "fix_proposed");
});

// ---------------------------------------------------------------------------
// Scenario 14: Retry limit exceeded
// ---------------------------------------------------------------------------
test("Scenario 14: Persistent HTTP 429 errors terminate when max retries exceeded", async () => {
  const client = new GroqRemediationClient({
    apiKey: "mock-key",
    model: "openai/gpt-oss-120b",
    maxRetries: 2,
    baseDelayMs: 10,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });

  let calls = 0;
  client.groq = {
    chat: {
      completions: {
        create: async () => {
          calls++;
          const err = new Error("Rate limit exceeded 429");
          err.status = 429;
          throw err;
        },
      },
    },
  };

  const res = await client.requestStructuredPatch({
    targetFile: "src/App.jsx",
    errorDetails: "SyntaxError",
    codeContext: "const a = 1;",
  });

  assert.equal(res.success, false);
  assert.equal(res.retries, 2);
  assert.match(res.error, /Groq API failure.*Rate limit/i);
});

// ---------------------------------------------------------------------------
// Scenario 15: Duplicate GitHub webhook delivery
// ---------------------------------------------------------------------------
test("Scenario 15: Duplicate GitHub webhook delivery ID is rejected", () => {
  const lock = new RunLock(10000);
  const deliveryId = "deliv_123456789";

  const first = lock.acquire("repo-1", 100, 1, deliveryId);
  assert.equal(first, true);

  // Exact same delivery redelivery
  const duplicate = lock.acquire("repo-1", 100, 1, deliveryId);
  assert.equal(duplicate, false);

  lock.clear();
});

// ---------------------------------------------------------------------------
// Scenario 16: Concurrent workflow attempts
// ---------------------------------------------------------------------------
test("Scenario 16: Concurrent workflow runs for the same attempt are rejected", () => {
  const lock = new RunLock(10000);

  const attempt1 = lock.acquire("repo-99", 555, 1, "del-1");
  assert.equal(attempt1, true);

  // Simultaneous second webhook arriving while attempt 1 is in-flight
  const attempt2 = lock.acquire("repo-99", 555, 1, "del-2");
  assert.equal(attempt2, false);

  lock.clear();
});

// ---------------------------------------------------------------------------
// Scenario 17: Successful end-to-end remediation produces VERIFIED report
// ---------------------------------------------------------------------------
test("Scenario 17: Successful deterministic remediation produces VERIFIED report and PR summary", async () => {
  const ws = await createGitWorkspace("src/app.js", "export function calc() {\n  return 1;\n}\n");
  try {
    const sandbox = new Sandbox(ws.dir);
    const tools = new AgentTools({ workspaceDir: ws.dir, sandbox });

    const agent = new DiagnoserAgent({
      tools,
      apiKey: "mock-key",
      model: "openai/gpt-oss-120b",
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    // Mock Groq returning valid unified diff
    agent.groqClient.requestStructuredPatch = async () => ({
      success: true,
      data: {
        status: "fix_proposed",
        file: "src/app.js",
        fix_type: "syntax_error",
        patch: "@@ -1,3 +1,3 @@\n export function calc() {\n-  return 1;\n+  return 2;\n }\n",
        explanation: "Incremented calculation to fix test",
      },
      tokenUsage: { promptTokens: 100, completionTokens: 40, totalTokens: 140 },
      retries: 0,
    });

    const report = await agent.runDeterministicRemediationPipeline({
      culprits: [{ targetFile: "src/app.js", lineNum: 2, errors: ["syntax error"] }],
      repo: "owner/repo",
      runId: 9999,
      runAttempt: 1,
      explicitChecks: {
        tests: {
          command: 'node -e "process.exit(0)"',
          cwd: ws.dir,
        },
      },
    });

    assert.equal(report.finalState, "VERIFIED");
    assert.deepEqual(report.modifiedFiles, ["src/app.js"]);
    assert.equal(report.patchValidation.status, "passed");
    assert.equal(report.patchApplication.status, "applied");

    const prMd = report.toPRMarkdown();
    assert.match(prMd, /Remediation State.*VERIFIED/);
    assert.match(prMd, /Human approval is required before merging/);
    assert.match(prMd, /Incremented calculation/);
  } finally {
    await ws.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Scenario 18: Rollback after verification failure
// ---------------------------------------------------------------------------
test("Scenario 18: Verification failure rolls back workspace to original commit cleanly", async () => {
  const ws = await createGitWorkspace("src/app.js", "export function check() {\n  return true;\n}\n");
  try {
    const sandbox = new Sandbox(ws.dir);
    const tools = new AgentTools({ workspaceDir: ws.dir, sandbox });

    const agent = new DiagnoserAgent({
      tools,
      apiKey: "mock-key",
      model: "openai/gpt-oss-120b",
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    // Mock Groq returning a patch that applies cleanly, but verification will fail
    agent.groqClient.requestStructuredPatch = async () => ({
      success: true,
      data: {
        status: "fix_proposed",
        file: "src/app.js",
        fix_type: "logic_error",
        patch: "@@ -1,3 +1,3 @@\n export function check() {\n-  return true;\n+  return false;\n }\n",
        explanation: "Candidate patch that breaks tests",
      },
      tokenUsage: { promptTokens: 90, completionTokens: 30, totalTokens: 120 },
      retries: 0,
    });

    const report = await agent.runDeterministicRemediationPipeline({
      culprits: [{ targetFile: "src/app.js", lineNum: 2, errors: ["test failure"] }],
      repo: "owner/repo",
      runId: 8888,
      runAttempt: 1,
      explicitChecks: {
        tests: {
          command: 'node -e "console.error(\'Tests failed\'); process.exit(1)"',
          cwd: ws.dir,
        },
      },
    });

    // Verification must report FAILED
    assert.equal(report.finalState, "FAILED");

    // Workspace MUST be cleanly rolled back to original commit
    const content = await fs.readFile(ws.filePath, "utf-8");
    assert.equal(content.replace(/\r\n/g, "\n"), "export function check() {\n  return true;\n}\n");

    const { stdout: diff } = await execa("git", ["diff"], { cwd: ws.dir });
    assert.equal(diff.trim(), "");
  } finally {
    await ws.cleanup();
  }
});
