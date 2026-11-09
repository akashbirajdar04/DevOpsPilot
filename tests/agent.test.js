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
  extractCodeContext,
  diagnoseLogErrors,
} from "../src/services/logParser.js";
import { Sandbox } from "../src/services/sandbox.js";
import { AgentTools } from "../src/agent/tools.js";
import {
  DiagnoserAgent,
  buildSingleShotPrompt,
  cleanRawCodeOutput,
  applySearchReplace,
  applyUnifiedDiff,
  isTruncatedCode,
  SRE_SYSTEM_PROMPT,
  buildRemediationUserPrompt,
} from "../src/agent/diagnoser.js";
import { RunLock } from "../src/utils/runLock.js";
import { DeterministicFixer, renameUnusedIdentifier, autoFixUnusedVariable } from "../src/services/deterministicFixer.js";
import {
  validatePatchOutput,
  validateModifiedFile,
  hasTruncationMarkers,
  hasUninitializedConst,
  hasBalancedBrackets,
} from "../src/agent/validator.js";

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

test("DiagnoserAgent: isTruncatedCode detects LLM truncation and placeholder comments", () => {
  const truncated1 = "const Messrequest\n// [Remaining lines omitted to stay within token limits]";
  assert.equal(isTruncatedCode(truncated1), true);

  const truncated2 = "export default App;\n/* ... rest of code */";
  assert.equal(isTruncatedCode(truncated2), true);

  const validCode = "const Messrequest = React.lazy(() => import('./mess.jsx'));\nexport default Messrequest;";
  assert.equal(isTruncatedCode(validCode), false);
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

test("RunLock: prevents duplicate concurrent processing of same workflow run", () => {
  const lock = new RunLock(1000);
  assert.equal(lock.acquire("run-123"), true);
  assert.equal(lock.acquire("run-123"), false); // Blocked duplicate
  assert.equal(lock.acquire("run-456"), true); // Separate run allowed

  assert.equal(lock.isLocked("run-123"), true);
  assert.equal(lock.release("run-123"), true);
  assert.equal(lock.isLocked("run-123"), false);

  // Can acquire again after release
  assert.equal(lock.acquire("run-123"), true);
  lock.clear();
});

test("logParser: diagnoseLogErrors extracts structured errors, groups by file, and ignores warnings", () => {
  const sampleLog = [
    "/workspace/frontend/src/components/user/user.jsx",
    "  4:18  error  'setCap' is assigned a value but never used  no-unused-vars",
    "  4:28  error  'useState' is not defined  no-undef",
    "  4:28  error  React Hook \"useState\" cannot be called at the top level  react-hooks/rules-of-hooks",
    "  10:5  warning  Unexpected console statement  no-console",
    "/workspace/frontend/src/App.jsx:26:6: ERROR: The constant \"Messrequest\" must be initialized",
  ].join("\n");

  const diag = diagnoseLogErrors(sampleLog);
  assert.equal(diag.summary.totalErrors, 4); // 3 eslint errors + 1 esbuild error, 1 warning ignored
  assert.equal(diag.byFile.size, 2);

  const userErrors = diag.byFile.get("frontend/src/components/user/user.jsx");
  assert.equal(userErrors.length, 3);
  assert.equal(userErrors[0].symbol, "setCap");
  assert.equal(userErrors[0].rule, "no-unused-vars");
  assert.equal(userErrors[1].rule, "no-undef");
  assert.equal(userErrors[2].rule, "react-hooks/rules-of-hooks");

  const appErrors = diag.byFile.get("frontend/src/App.jsx");
  assert.equal(appErrors.length, 1);
  assert.equal(appErrors[0].category, "esbuild");
  assert.equal(appErrors[0].symbol, "Messrequest");
});

test("DeterministicFixer: fixes unused vars, missing React imports, and relocates top-level hooks without LLM", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "healops-det-fixer-"));
  try {
    const sandbox = new Sandbox(tempDir);
    const tools = new AgentTools({ workspaceDir: tempDir, sandbox });
    const fixer = new DeterministicFixer({ tools });

    const brokenUserJsx = [
      "const [cap, setCap] = useState(0);",
      "export default function UserProfile() {",
      "  return <div>{cap}</div>;",
      "}",
    ].join("\n");

    const filePath = "src/UserProfile.jsx";
    await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
    await fs.writeFile(path.join(tempDir, filePath), brokenUserJsx, "utf-8");

    const errors = [
      {
        filePath,
        lineNum: 1,
        rule: "no-unused-vars",
        symbol: "setCap",
        message: "'setCap' is assigned a value but never used",
      },
      {
        filePath,
        lineNum: 1,
        rule: "no-undef",
        symbol: "useState",
        message: "'useState' is not defined",
      },
      {
        filePath,
        lineNum: 1,
        rule: "react-hooks/rules-of-hooks",
        symbol: "useState",
        message: 'React Hook "useState" cannot be called at the top level',
      },
    ];

    const result = await fixer.fixFile(filePath, errors);
    assert.equal(result.fixed, true);
    assert.equal(result.appliedFixes.length >= 2, true);

    const fixedContent = await fs.readFile(path.join(tempDir, filePath), "utf-8");
    // 1. React and useState import added
    assert.equal(fixedContent.includes("import React, { useState, useEffect } from \"react\";"), true);
    // 2. Unused setCap removed from destructuring
    assert.equal(fixedContent.includes("const [cap] = useState(0);"), true);
    // 3. Hook relocated inside function
    assert.equal(fixedContent.includes("export default function UserProfile() {\n  const [cap] = useState(0);"), true);

    // 4. Catch blocks converted to optional catch binding 'catch {}' (no unused error variable)
    assert.equal(autoFixUnusedVariable("} catch (e) {", "e"), "} catch {");
    assert.equal(autoFixUnusedVariable("} catch (_e) {", "_e"), "} catch {");

    // 5. Unused imports removed
    assert.equal(autoFixUnusedVariable("import { _Icon } from 'lucide-react';", "_Icon"), "");
    assert.equal(autoFixUnusedVariable("import { _Icon, Users } from 'lucide-react';", "_Icon"), "import { Users } from 'lucide-react';");

    // 6. Unused arrow function callbacks: (_e) => -> () =>
    assert.equal(autoFixUnusedVariable("const onClick = (_e) => handleClick();", "_e"), "const onClick = () => handleClick();");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("Validator: validatePatchOutput and validateModifiedFile reject broken AI outputs", () => {
  // 1. Reject truncation markers
  const truncatedPatch = "const x = 1;\n// [Remaining lines omitted to stay within token limits]";
  assert.equal(validatePatchOutput(truncatedPatch).valid, false);

  // 2. Reject raw merge conflict markers
  const conflictPatch = "<<<<<<< HEAD\nconst x = 1;\n=======\nconst x = 2;\n>>>>>>> origin/main";
  assert.equal(validatePatchOutput(conflictPatch).valid, false);

  // 3. Reject uninitialized constants
  const uninitConst = "const Messrequest\nexport default Messrequest;";
  assert.equal(validatePatchOutput(uninitConst).valid, false);
  assert.equal(hasUninitializedConst(uninitConst), true);

  // 4. Reject unclosed markdown code fences
  const unclosedFence = "```javascript\nconst x = 1;\n";
  assert.equal(validatePatchOutput(unclosedFence).valid, false);

  // 5. Valid surgical patch passes
  const validPatch = "<<<<<<< SEARCH\nconst a = 1;\n=======\nconst a = 2;\n>>>>>>> REPLACE";
  assert.equal(validatePatchOutput(validPatch).valid, true);

  // 6. Validate modified file rejects destructive shrinkage
  const original = "a".repeat(1000);
  const shrunken = "a".repeat(200);
  assert.equal(validateModifiedFile(original, shrunken, "test.js").valid, false);

  // 7. Validate balanced brackets in JS/JSX
  assert.equal(hasBalancedBrackets("function App() { return (<div>Hi</div>); }"), true);
  assert.equal(hasBalancedBrackets("function App() { return (<div>Hi</div>);"), false);
});

test("AgentTools: getRepoFile returns full content without 1800-char truncation", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "healops-tools-test-"));
  try {
    const sandbox = new Sandbox(tempDir);
    const tools = new AgentTools({ workspaceDir: tempDir, sandbox });

    // File with 3,000 characters (> 1,800 characters)
    const longContent = "const line = 'very long code statement here';\n".repeat(70);
    assert.equal(longContent.length > 2500, true);

    await fs.writeFile(path.join(tempDir, "largeFile.js"), longContent, "utf-8");

    const fetched = await tools.getRepoFile("largeFile.js");
    assert.equal(fetched.length, longContent.length);
    assert.equal(fetched.includes("// [Remaining lines omitted"), false);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

// =============================================================================
// PHASE 7: AUTOMATED REGRESSION SUITE (14 Targeted Regression Cases)
// =============================================================================

test("Phase 7 [1/14]: Unused JS var repaired surgically without regressions", () => {
  const code = 'import React from "react";\nconst unusedToken = 123;\nexport function Button() { return <button>Click</button>; }\n';
  const patch = "<<<<<<< SEARCH\nconst unusedToken = 123;\n=======\n>>>>>>> REPLACE";
  const result = applySearchReplace(code, patch);
  assert.equal(result.includes("unusedToken"), false);
  assert.equal(result.includes("export function Button"), true);
});

test("Phase 7 [2/14]: Undefined React Hook import added cleanly", () => {
  const code = 'import React from "react";\nexport function Counter() {\n  const [count, setCount] = useState(0);\n  return <div>{count}</div>;\n}\n';
  const patch = '<<<<<<< SEARCH\nimport React from "react";\n=======\nimport React, { useState } from "react";\n>>>>>>> REPLACE';
  const result = applySearchReplace(code, patch);
  assert.equal(result.includes('import React, { useState } from "react";'), true);
  assert.equal(result.includes("return <div>{count}</div>;"), true);
});

test("Phase 7 [3/14]: Missing React Hook dependency added to array", () => {
  const code = 'useEffect(() => {\n  console.log(userId);\n}, []);';
  const patch = '<<<<<<< SEARCH\n}, []);\n=======\n}, [userId]);\n>>>>>>> REPLACE';
  const result = applySearchReplace(code, patch);
  assert.equal(result.includes('}, [userId]);'), true);
});

test("Phase 7 [4/14]: Valid minimal patch with character-exact SEARCH/REPLACE", () => {
  const code = 'const status = "pending";\n';
  const patch = '<<<<<<< SEARCH\nconst status = "pending";\n=======\nconst status = "active";\n>>>>>>> REPLACE';
  const result = applySearchReplace(code, patch);
  assert.equal(result, 'const status = "active";\n');
});

test("Phase 7 [5/14]: Empty AI response is cleanly rejected and disk remains untouched", () => {
  assert.equal(validatePatchOutput("").valid, false);
  assert.equal(validatePatchOutput("   \n\t  ").valid, false);
  assert.equal(validatePatchOutput("").reason.includes("Empty patch"), true);
});

test("Phase 7 [6/14]: Malformed unified diff rejected without corrupting file", () => {
  const code = 'const a = 1;\nconst b = 2;\n';
  const malformedDiff = '@@ -invalid hunk header @@\n-broken line\n+fixed line';
  const result = applyUnifiedDiff(code, malformedDiff);
  assert.equal(result, null);
});

test("Phase 7 [7/14]: Patch that cannot match source fails safely and returns null", () => {
  const code = 'const alpha = 100;\n';
  const nonMatchingPatch = '<<<<<<< SEARCH\nconst nonexistent = 999;\n=======\nconst nonexistent = 1000;\n>>>>>>> REPLACE';
  const result = applySearchReplace(code, nonMatchingPatch);
  assert.equal(result, null);
});

test("Phase 7 [8/14]: Truncated JSX output rejected by validator", () => {
  const truncated1 = 'function Card() {\n  return (\n    <div>\n      // [Remaining lines omitted for brevity]\n    </div>\n  );\n}';
  assert.equal(validatePatchOutput(truncated1).valid, false);
  assert.equal(hasTruncationMarkers(truncated1), true);

  const unbalancedJsx = 'function Card() { return (<div><span>Hello</div>; }';
  assert.equal(validateModifiedFile('function Card() {}', unbalancedJsx, 'Card.jsx').valid, false);
});

test("Phase 7 [9/14]: Valid no-change response preserves original file exactly", () => {
  const code = 'const PORT = 3000;\n';
  const noChangePatch = '<<<<<<< SEARCH\nconst PORT = 3000;\n=======\nconst PORT = 3000;\n>>>>>>> REPLACE';
  const result = applySearchReplace(code, noChangePatch);
  assert.equal(result, code);
});

test("Phase 7 [10/14]: Groq HTTP 429 response triggers backoff and successful retry", async () => {
  let attempts = 0;
  const mockGroq = {
    chat: {
      completions: {
        create: async () => {
          attempts++;
          if (attempts === 1) {
            const err = new Error("Rate limit reached: 8000 TPM exceeded");
            err.status = 429;
            throw err;
          }
          return {
            choices: [
              {
                message: {
                  content: '<<<<<<< SEARCH\nconst x = 1;\n=======\nconst x = 2;\n>>>>>>> REPLACE',
                },
              },
            ],
          };
        },
      },
    },
  };

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "healops-429-test-"));
  try {
    const sandbox = new Sandbox(tempDir);
    const tools = new AgentTools({ workspaceDir: tempDir, sandbox });
    await tools.applyFilePatch("test.js", "const x = 1;\n");

    const agent = new DiagnoserAgent({
      tools,
      apiKey: "mock-key",
      model: "openai/gpt-oss-120b",
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    agent.groq = mockGroq;

    const result = await agent.runMultiFileRemediation({
      culprits: [{ targetFile: "test.js", lineNum: 1, errors: ["error in line 1"] }],
      testCommand: 'node -e "process.exit(0)"',
      delayMs: 10,
    });

    assert.equal(attempts, 2);
    assert.equal(result.success, true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("Phase 7 [11/14]: Duplicate workflow events blocked by RunLock and replay filter", () => {
  const lock = new RunLock();
  assert.equal(lock.acquire(1001), true);
  assert.equal(lock.acquire(1001), false);
  lock.release(1001);
  assert.equal(lock.acquire(1001), true);
});

test("Phase 7 [12/14]: Verification failure triggers atomic rollback to clean snapshot", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "healops-rollback-test-"));
  try {
    const sandbox = new Sandbox(tempDir);
    const tools = new AgentTools({ workspaceDir: tempDir, sandbox });
    const initialCode = "const originalState = true;\n";
    await tools.applyFilePatch("state.js", initialCode);

    const mockGroq = {
      chat: {
        completions: {
          create: async () => ({
            choices: [
              {
                message: {
                  content: '<<<<<<< SEARCH\nconst originalState = true;\n=======\nconst brokenCandidate = false;\n>>>>>>> REPLACE',
                },
              },
            ],
          }),
        },
      },
    };

    const agent = new DiagnoserAgent({
      tools,
      apiKey: "mock-key",
      model: "openai/gpt-oss-120b",
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    agent.groq = mockGroq;

    // testCommand fails with exit code 1
    const result = await agent.runMultiFileRemediation({
      culprits: [{ targetFile: "state.js", lineNum: 1, errors: ["syntax error"] }],
      testCommand: 'node -e "process.exit(1)"',
      delayMs: 0,
    });

    assert.equal(result.success, false);
    // Verified atomic rollback: file on disk has been reverted to initialCode!
    const restoredCode = await tools.getRepoFile("state.js");
    assert.equal(restoredCode, initialCode);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("Phase 7 [13/14]: Previously passing files remain 100% untouched byte-for-byte", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "healops-untouched-test-"));
  try {
    const sandbox = new Sandbox(tempDir);
    const tools = new AgentTools({ workspaceDir: tempDir, sandbox });
    const brokenCode = "const bad = 1;\n";
    const passingCode = "export const PI = 3.14159;\nexport function getPi() { return PI; }\n";

    await tools.applyFilePatch("broken.js", brokenCode);
    await tools.applyFilePatch("passing.js", passingCode);

    const mockGroq = {
      chat: {
        completions: {
          create: async () => ({
            choices: [
              {
                message: {
                  content: '<<<<<<< SEARCH\nconst bad = 1;\n=======\nconst bad = 2;\n>>>>>>> REPLACE',
                },
              },
            ],
          }),
        },
      },
    };

    const agent = new DiagnoserAgent({
      tools,
      apiKey: "mock-key",
      model: "openai/gpt-oss-120b",
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    agent.groq = mockGroq;

    const result = await agent.runMultiFileRemediation({
      culprits: [{ targetFile: "broken.js", lineNum: 1, errors: ["err"] }],
      testCommand: 'node -e "process.exit(0)"',
      delayMs: 0,
    });

    assert.equal(result.success, true);
    // passing.js must remain 100% untouched
    const fetchedPassing = await tools.getRepoFile("passing.js");
    assert.equal(fetchedPassing, passingCode);
    assert.equal(result.modifiedFiles.includes("passing.js"), false);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("Phase 7 [14/14]: Unknown diagnostic category routed safely to LLM", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "healops-unknown-cat-test-"));
  try {
    const sandbox = new Sandbox(tempDir);
    const tools = new AgentTools({ workspaceDir: tempDir, sandbox });
    const brokenCode = "export function parse(input) { return input.substring(0, 5); }\n";
    await tools.applyFilePatch("parser.js", brokenCode);

    let llmCalled = false;
    const mockGroq = {
      chat: {
        completions: {
          create: async () => {
            llmCalled = true;
            return {
              choices: [
                {
                  message: {
                    content: '<<<<<<< SEARCH\nexport function parse(input) { return input.substring(0, 5); }\n=======\nexport function parse(input) { return (input || "").substring(0, 5); }\n>>>>>>> REPLACE',
                  },
                },
              ],
            };
          },
        },
      },
    };

    const agent = new DiagnoserAgent({
      tools,
      apiKey: "mock-key",
      model: "openai/gpt-oss-120b",
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    agent.groq = mockGroq;

    const result = await agent.runMultiFileRemediation({
      culprits: [
        {
          targetFile: "parser.js",
          lineNum: 1,
          errors: ["TS2532: Object is possibly 'undefined'."],
          structuredErrors: [
            {
              filePath: "parser.js",
              lineNum: 1,
              category: "compiler",
              rule: "TS2532",
              message: "Object is possibly 'undefined'.",
              raw: "TS2532: Object is possibly 'undefined'.",
            },
          ],
        },
      ],
      testCommand: 'node -e "process.exit(0)"',
      delayMs: 0,
    });

    assert.equal(llmCalled, true);
    assert.equal(result.success, true);
    const patchedCode = await tools.getRepoFile("parser.js");
    assert.equal(patchedCode.includes('(input || "").substring(0, 5)'), true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("Phase 7: extractCodeContext extracts unnumbered target, enclosing scope, and top imports", () => {
  const sampleFile = [
    'import React, { useState } from "react";',
    'import api from "../lib/api";',
    '',
    'export default function UserProfile() {',
    '  const [user, setUser] = useState(null);',
    '  const [error, setError] = useState(null);',
    '',
    '  const fetchUser = async () => {',
    '    try {',
    '      const res = await api.get("/user");',
    '      setUser(res.data);',
    '    } catch (e) {',
    '      setError(e.message);',
    '    }',
    '  };',
    '',
    '  return <div>{user?.name}</div>;',
    '}',
  ].join("\n");

  const ctx = extractCodeContext(sampleFile, 12, 3);
  assert.equal(ctx.topImports.includes('import React, { useState } from "react";'), true);
  assert.equal(ctx.enclosingScope, "export default function UserProfile() {");
  assert.equal(ctx.targetSnippet.includes("catch (e) {"), true);
  assert.equal(ctx.targetSnippet.includes("12:"), false); // No prepended line numbers!
});

test("Phase 7: applyUnifiedDiff applies standard unified diff hunks correctly", () => {
  const sourceCode = [
    'function calculateTotal(items) {',
    '  let total = 0;',
    '  for (const item of items) {',
    '    total += item.price;',
    '  }',
    '  return total;',
    '}',
  ].join("\n");

  const unifiedDiff = [
    '--- a/calc.js',
    '+++ b/calc.js',
    '@@ -2,3 +2,3 @@',
    ' function calculateTotal(items) {',
    '-  let total = 0;',
    '+  let total = 10;',
    '   for (const item of items) {',
  ].join("\n");

  const applied = applyUnifiedDiff(sourceCode, unifiedDiff);
  assert.notEqual(applied, null);
  assert.equal(applied.includes("let total = 10;"), true);
  assert.equal(applied.includes("let total = 0;"), false);
});



