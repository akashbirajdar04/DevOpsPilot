/**
 * Integration and unit test suite for HealOps Single-Shot Deterministic Remediation Engine.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { scanContentForSecrets } from "../src/utils/secretGuard.js";
import {
  parseLog,
  extractCulpritLocation,
  extractAllCulprits,
  extractFatalErrorLine,
  getLineWindow,
} from "../src/services/logParser.js";
import { Sandbox } from "../src/services/sandbox.js";
import { AgentTools } from "../src/agent/tools.js";
import {
  DiagnoserAgent,
  buildSingleShotPrompt,
  cleanRawCodeOutput,
  applySearchReplace,
  SRE_SYSTEM_PROMPT,
  buildRemediationUserPrompt,
} from "../src/agent/diagnoser.js";

import { GitOpsService } from "../src/services/gitOps.js";
import healOpsApp from "../index.js";

test("secretGuard: blocks leaked AWS keys, GitHub tokens, and .env files", () => {
  const cleanResult = scanContentForSecrets("export const PORT = 3000;", "index.js");
  assert.equal(cleanResult.passed, true);
  assert.equal(cleanResult.violations.length, 0);

  const awsResult = scanContentForSecrets("AKIAIOSFODNN7EXAMPLE", "config.js");
  assert.equal(awsResult.passed, false);
  assert.match(awsResult.violations[0], /AWS Access Key ID/);

  const ghResult = scanContentForSecrets("ghp_1234567890abcdefghijklmnopqrstuvwxyz12", "app.js");
  assert.equal(ghResult.passed, false);
  assert.match(ghResult.violations[0], /GitHub Personal Access Token/);

  const envResult = scanContentForSecrets("FOO=bar", ".env");
  assert.equal(envResult.passed, false);
  assert.match(envResult.violations[0], /\.env files must never be committed/);
});

test("logParser: extractCulpritLocation matches /(?:[\\w.-]+\\/)*[\\w.-]+\\.(?:jsx?|tsx?|json|py):(\\d+)/i", () => {
  const logSnippet = [
    "/workspace/frontend/src/components/Profile.jsx:14:3",
    "error: 'toast' is not defined no-undef",
  ].join("\n");

  const culprit = extractCulpritLocation(logSnippet);
  assert.notEqual(culprit, null);
  assert.equal(culprit.targetFile, "frontend/src/components/Profile.jsx");
  assert.equal(culprit.lineNum, 14);

  // Test GitHub Actions runner paths: /home/runner/work/project/project/...
  const runnerLog = "/home/runner/work/project/project/frontend/src/components/complaints.jsx:30:18\nerror: 'e' is defined but never used";
  const runnerCulprit = extractCulpritLocation(runnerLog);
  assert.notEqual(runnerCulprit, null);
  assert.equal(runnerCulprit.targetFile, "frontend/src/components/complaints.jsx");
  assert.equal(runnerCulprit.lineNum, 30);

  // Test GitHub Actions multi-line ESLint table format with Error: prefix
  const ghaTableLog = [
    "  /home/runner/work/project/project/frontend/src/components/mess/mess.jsx",
    "Error:   10:15  error  'setDay' is assigned a value but never used. Allowed unused vars must match /^[A-Z_]/u   no-unused-vars",
    "Error:   11:16  error  'setSlot' is assigned a value but never used.",
  ].join("\n");
  const ghaCulprit = extractCulpritLocation(ghaTableLog);
  assert.notEqual(ghaCulprit, null);
  assert.equal(ghaCulprit.targetFile, "frontend/src/components/mess/mess.jsx");
  assert.equal(ghaCulprit.lineNum, 10);
});

test("logParser: extractAllCulprits identifies all broken files and ignores warnings", () => {
  const multiErrorLog = [
    "  /home/runner/work/project/project/frontend/src/components/mess/mess.jsx",
    "Error:   10:15  error  'setDay' is assigned a value but never used  no-unused-vars",
    "Error:   11:16  error  'setSlot' is assigned a value but never used  no-unused-vars",
    "",
    "/home/runner/work/project/project/frontend/src/components/payment.jsx",
    "Error:    3:8   error  'api' is defined but never used  no-unused-vars",
    "",
    "/home/runner/work/project/project/frontend/src/components/polls/PollList.jsx",
    "Warning:   41:8  warning  React Hook useEffect has a missing dependency  react-hooks/exhaustive-deps",
  ].join("\n");

  const culprits = extractAllCulprits(multiErrorLog);
  assert.equal(culprits.length, 2);
  assert.equal(culprits[0].targetFile, "frontend/src/components/mess/mess.jsx");
  assert.equal(culprits[0].lineNum, 10);
  assert.equal(culprits[0].errors.length, 2);

  assert.equal(culprits[1].targetFile, "frontend/src/components/payment.jsx");
  assert.equal(culprits[1].lineNum, 3);
  assert.equal(culprits[1].errors.length, 1);
});

test("DiagnoserAgent: applySearchReplace applies surgical search and replace blocks", () => {
  const code = [
    "import { useState } from 'react';",
    "const [setDay, setSlot] = useState();",
    "export const App = () => <div>Hello</div>;",
  ].join("\n");

  const patch = [
    "<<<<<<< SEARCH",
    "const [setDay, setSlot] = useState();",
    "=======",
    "const [_setDay, _setSlot] = useState();",
    ">>>>>>> REPLACE",
  ].join("\n");

  const updated = applySearchReplace(code, patch);
  assert.notEqual(updated, null);
  assert.equal(updated.includes("const [_setDay, _setSlot] = useState();"), true);
  assert.equal(updated.includes("export const App = () => <div>Hello</div>;"), true);
});



test("logParser: extractFatalErrorLine extracts FAIL, error:, or Error: line", () => {
  const eslintLog = [
    "/workspace/frontend/src/components/Profile.jsx:14:3",
    "error: 'toast' is not defined no-undef",
    "Process completed with exit code 1.",
  ].join("\n");
  assert.equal(extractFatalErrorLine(eslintLog), "error: 'toast' is not defined no-undef");

  const jestLog = [
    "FAIL tests/unit.test.js",
    "  ● Cannot find module 'lodash'",
    "Process completed with exit code 1.",
  ].join("\n");
  assert.equal(extractFatalErrorLine(jestLog), "FAIL tests/unit.test.js");

  const eslintTableLog = [
    "=== Log: 0_Frontend (Lint & Build).txt ===",
    "/workspace/frontend/src/components/complaints.jsx",
    "  28:18  error  'e' is defined but never used  no-unused-vars",
    "Process completed with exit code 1.",
  ].join("\n");
  assert.equal(extractFatalErrorLine(eslintTableLog), "28:18  error  'e' is defined but never used  no-unused-vars");

  const pyLog = [
    "Error: Configuration status is not ready! Found: broken",
  ].join("\n");
  assert.equal(extractFatalErrorLine(pyLog), "Error: Configuration status is not ready! Found: broken");
});


test("logParser: getLineWindow extracts targeted 30-line code window (15 lines before to 15 after)", () => {
  const sampleCode = Array.from({ length: 60 }, (_, i) => `const line_${i + 1} = true;`).join("\n");
  const lineWindow = getLineWindow(sampleCode, 20, 15);

  // Center around line 20: lines 5 to 35
  assert.equal(lineWindow.includes("20: const line_20 = true;"), true);
  assert.equal(lineWindow.includes("5: const line_5 = true;"), true);
  assert.equal(lineWindow.includes("35: const line_35 = true;"), true);
  assert.equal(lineWindow.includes("4: const line_4 = true;"), false);
  assert.equal(lineWindow.includes("36: const line_36 = true;"), false);
});

test("AgentTools: read, patch, and execute sandboxed test commands", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "healops-test-tools-"));
  try {
    const sandbox = new Sandbox(tempDir);
    const tools = new AgentTools({ workspaceDir: tempDir, sandbox });

    await tools.applyFilePatch("calc.js", "export function multiply(a, b) { return a * b; }");
    const content = await tools.getRepoFile("calc.js");
    assert.equal(content, "export function multiply(a, b) { return a * b; }");

    await tools.applyFilePatch("calc.js", "export function multiply(a, b) { return a * b * 2; }");
    const updated = await tools.getRepoFile("calc.js");
    assert.equal(updated, "export function multiply(a, b) { return a * b * 2; }");

    const testJson = await tools.runSandboxTest("node -e \"console.log('Sandbox Alive')\"");
    const testResult = JSON.parse(testJson);
    assert.equal(testResult.exitCode, 0);
    assert.equal(testResult.stdout.includes("Sandbox Alive"), true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("DiagnoserAgent: single-shot prompt formatting and code fence stripping", () => {
  const prompt = buildSingleShotPrompt({
    fatalErrorLine: "error: 'toast' is not defined no-undef",
    filePath: "frontend/src/components/Profile.jsx",
    lineWindowSnippet: "14: toast.error('failed');",
  });

  assert.equal(prompt.includes("Senior Staff Site Reliability"), true);
  assert.equal(prompt.includes("The build failed with this error:"), true);
  assert.equal(prompt.includes("error: 'toast' is not defined no-undef"), true);
  assert.equal(prompt.includes("Here is the code around the failure in 'frontend/src/components/Profile.jsx':"), true);
  assert.equal(prompt.includes("Return ONLY the raw file content. Do not include markdown code fences"), true);

  // Clean raw output test
  const fenced = "```javascript\nexport const x = 1;\n```";
  assert.equal(cleanRawCodeOutput(fenced), "export const x = 1;");
});

test("DiagnoserAgent: SRE_SYSTEM_PROMPT and buildRemediationUserPrompt format correctly", () => {
  assert.equal(SRE_SYSTEM_PROMPT.includes("Senior Staff Site Reliability"), true);
  assert.equal(SRE_SYSTEM_PROMPT.includes("REMEDIATION TAXONOMY & RULES"), true);
  assert.equal(SRE_SYSTEM_PROMPT.includes("ESLint / Linter Failures:"), true);
  assert.equal(SRE_SYSTEM_PROMPT.includes("<<<<<<< SEARCH"), true);

  const userPrompt = buildRemediationUserPrompt({
    filePath: "frontend/src/components/mess/mess.jsx",
    errorMessage: "'useLocation' is defined but never used",
    lineWindowSnippet: "2: import { NavLink, Outlet, useLocation } from 'react-router-dom';",
  });

  assert.equal(userPrompt.includes("Target File: frontend/src/components/mess/mess.jsx"), true);
  assert.equal(userPrompt.includes("'useLocation' is defined but never used"), true);
  assert.equal(userPrompt.includes("Code Context (centered on error line):"), true);
  assert.equal(userPrompt.includes("Provide the surgical SEARCH/REPLACE block"), true);
});

test("Integration: Single-Shot DiagnoserAgent fixes broken code, verifies in 1 turn, and stays under 800 tokens", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "healops-single-shot-"));
  try {
    const brokenPackageJson = JSON.stringify(
      {
        name: "sample-app",
        version: "1.0.0",
        type: "module",
        scripts: { test: "node test.js" },
      },
      null,
      2
    );

    const brokenTestJs = `
import fs from 'node:fs';
const config = JSON.parse(fs.readFileSync('./config.json', 'utf-8'));
if (config.status !== 'ready') {
  console.error("Error: Configuration status is not ready! Found:", config.status);
  process.exit(1);
}
console.log("PASS: Configuration status is ready.");
`;

    const brokenConfigJson = JSON.stringify({ status: "broken" }, null, 2);
    const fixedConfigJson = JSON.stringify({ status: "ready" }, null, 2);

    await fs.writeFile(path.join(tempDir, "package.json"), brokenPackageJson, "utf-8");
    await fs.writeFile(path.join(tempDir, "test.js"), brokenTestJs, "utf-8");
    await fs.writeFile(path.join(tempDir, "config.json"), brokenConfigJson, "utf-8");

    const sandbox = new Sandbox(tempDir);
    const tools = new AgentTools({ workspaceDir: tempDir, sandbox });

    const agent = new DiagnoserAgent({
      tools,
      apiKey: "mock-key",
      model: "llama-3.1-8b-instant",
    });

    let recordedTokens = 0;
    let callCount = 0;

    agent.groq = {
      chat: {
        completions: {
          create: async ({ messages, temperature, model }) => {
            callCount++;
            assert.equal(temperature, 0.1);
            // Verify message format
            assert.equal(messages.length >= 1, true);
            const userMsg = messages.find((m) => m.role === "user") || messages[0];
            assert.equal(userMsg.role, "user");

            // Conservative token count estimation (~3.5 chars per token)
            const totalChars = messages.map((m) => m.content).join("\n").length;
            recordedTokens = Math.ceil(totalChars / 3.5);

            return {
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: `\`\`\`json\n${fixedConfigJson}\n\`\`\``,
                  },
                },
              ],
            };
          },
        },
      },
    };

    const remediation = await agent.runRemediation({
      fatalErrorLine: "Error: Configuration status is not ready! Found: broken",
      filePath: "config.json",
      lineWindowSnippet: "1: {\n2:   \"status\": \"broken\"\n3: }",
      testCommand: "npm test",
    });

    // 1. Must succeed in exactly 1 single-shot iteration
    assert.equal(remediation.success, true);
    assert.equal(remediation.iterations, 1);
    assert.equal(callCount, 1);

    // 2. Token count must be strictly under 800 tokens
    assert.equal(
      recordedTokens < 800,
      true,
      `Expected single-shot prompt tokens (${recordedTokens}) to be strictly below 800 tokens`
    );

    // 3. Workspace file must be updated
    const repaired = JSON.parse(await fs.readFile(path.join(tempDir, "config.json"), "utf-8"));
    assert.equal(repaired.status, "ready");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("Single-Shot: unverified fix exits cleanly without retrying or opening PR", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "healops-unverified-"));
  try {
    const sandbox = new Sandbox(tempDir);
    const tools = new AgentTools({ workspaceDir: tempDir, sandbox });

    const agent = new DiagnoserAgent({
      tools,
      apiKey: "mock-key",
      model: "llama-3.1-8b-instant",
    });

    let callCount = 0;
    agent.groq = {
      chat: {
        completions: {
          create: async () => {
            callCount++;
            return {
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: "export const broken = true;",
                  },
                },
              ],
            };
          },
        },
      },
    };

    const remediation = await agent.runRemediation({
      fatalErrorLine: "SyntaxError: Unexpected token",
      filePath: "app.js",
      lineWindowSnippet: "1: const broken = false;",
      testCommand: "node -e \"process.exit(1)\"", // Verification fails
    });

    // Must fail cleanly on iteration 1 without retrying
    assert.equal(remediation.success, false);
    assert.equal(remediation.iterations, 1);
    assert.equal(callCount, 1);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("Smee.io Replay Filter: drops stale events where runCompletedAt < serverBootTime", async () => {
  const eventLogs = [];
  const mockApp = {
    log: {
      info: (msg) => eventLogs.push(msg),
      warn: (msg) => eventLogs.push(msg),
      error: (msg) => eventLogs.push(msg),
    },
    on: (eventName, handler) => {
      mockApp.handler = handler;
    },
  };

  const bootTime = new Date("2026-10-26T12:00:00Z");
  healOpsApp(mockApp, bootTime);

  // Stale event completed before server bootTime
  const staleEvent = {
    payload: {
      workflow_run: {
        id: 40230962385,
        head_branch: "fix/ci-failure-40227760210",
        conclusion: "failure",
        updated_at: "2026-10-26T11:30:00Z", // 30 minutes before bootTime
      },
      repository: {
        owner: { login: "akashbirajdar04" },
        name: "project",
      },
    },
  };

  await mockApp.handler(staleEvent);

  const droppedLog = eventLogs.find((l) => l.includes("[STALE EVENT] Dropping replayed run from Smee.io"));
  assert.notEqual(droppedLog, undefined);
  assert.equal(droppedLog.includes("40230962385"), true);
});

test("DiagnoserAgent: runMultiFileRemediation patches all broken files and verifies together", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "healops-multi-file-"));
  try {
    const file1 = "src/a.js";
    const file2 = "src/b.js";
    await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
    await fs.writeFile(path.join(tempDir, file1), "const a_broken = 1;\nexport const a = a_broken;", "utf-8");
    await fs.writeFile(path.join(tempDir, file2), "const b_broken = 2;\nexport const b = b_broken;", "utf-8");

    const sandbox = new Sandbox(tempDir);
    const tools = new AgentTools({ workspaceDir: tempDir, sandbox });

    const agent = new DiagnoserAgent({
      tools,
      apiKey: "mock-key",
      model: "llama-3.1-8b-instant",
    });

    let calls = 0;
    agent.groq = {
      chat: {
        completions: {
          create: async ({ messages }) => {
            calls++;
            const userMsg = messages.find((m) => m.role === "user") || messages[0];
            const prompt = userMsg.content;
            if (prompt.includes("src/a.js")) {
              return {
                choices: [
                  {
                    message: {
                      role: "assistant",
                      content: "<<<<<<< SEARCH\nconst a_broken = 1;\n=======\nconst a_fixed = 1;\n>>>>>>> REPLACE",
                    },
                  },
                ],
              };
            } else {
              return {
                choices: [
                  {
                    message: {
                      role: "assistant",
                      content: "const b_fixed = 2;\nexport const b = b_fixed;",
                    },
                  },
                ],
              };
            }
          },
        },
      },
    };

    const culprits = [
      { targetFile: file1, lineNum: 1, errors: ["error: a_broken is invalid"] },
      { targetFile: file2, lineNum: 1, errors: ["error: b_broken is invalid"] },
    ];

    const result = await agent.runMultiFileRemediation({
      culprits,
      testCommand: "node -e \"process.exit(0)\"",
      delayMs: 10, // Fast delay for tests
    });

    assert.equal(result.success, true);
    assert.equal(result.modifiedFiles.length, 2);
    assert.equal(calls, 2);

    const contentA = await fs.readFile(path.join(tempDir, file1), "utf-8");
    const contentB = await fs.readFile(path.join(tempDir, file2), "utf-8");
    assert.equal(contentA.includes("const a_fixed = 1;"), true);
    assert.equal(contentB.includes("const b_fixed = 2;"), true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

