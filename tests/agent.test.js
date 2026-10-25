/**
 * Integration and unit test suite for HealOps GitHub App Agent.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { scanContentForSecrets } from "../src/utils/secretGuard.js";
import { parseLog } from "../src/services/logParser.js";
import { Sandbox } from "../src/services/sandbox.js";
import { AgentTools } from "../src/agent/tools.js";
import { DiagnoserAgent } from "../src/agent/diagnoser.js";

test("secretGuard: blocks leaked AWS keys, GitHub tokens, and .env files", () => {
  // Test clean content passes
  const cleanResult = scanContentForSecrets("export const PORT = 3000;", "index.js");
  assert.equal(cleanResult.passed, true);
  assert.equal(cleanResult.violations.length, 0);

  // Test AWS Key blocked
  const awsResult = scanContentForSecrets("AKIAIOSFODNN7EXAMPLE", "config.js");
  assert.equal(awsResult.passed, false);
  assert.match(awsResult.violations[0], /AWS Access Key ID/);

  // Test GitHub token blocked
  const ghResult = scanContentForSecrets("ghp_1234567890abcdefghijklmnopqrstuvwxyz12", "app.js");
  assert.equal(ghResult.passed, false);
  assert.match(ghResult.violations[0], /GitHub Personal Access Token/);

  // Test .env rejected
  const envResult = scanContentForSecrets("FOO=bar", ".env");
  assert.equal(envResult.passed, false);
  assert.match(envResult.violations[0], /\.env files must never be committed/);
});

test("logParser: strips ANSI codes and extracts 150-line error tail", () => {
  const rawLog = [
    "\x1B[31mFAIL\x1B[39m tests/unit.test.js",
    "  ● Cannot find module 'lodash'",
    "    Require stack: src/index.js",
    "Process completed with exit code 1.",
  ].join("\n");

  const parsed = parseLog(rawLog, 150);
  assert.equal(parsed.cleanLog.includes("\x1B"), false);
  assert.equal(parsed.extractedWindow.includes("FAIL tests/unit.test.js"), true);
  assert.equal(parsed.extractedWindow.includes("Cannot find module 'lodash'"), true);
});

test("AgentTools: read, patch, and execute sandboxed test commands", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "healops-test-tools-"));
  try {
    const sandbox = new Sandbox(tempDir);
    const tools = new AgentTools({ workspaceDir: tempDir, sandbox });

    // 1. Write initial file
    await tools.applyFilePatch("calc.js", "export function multiply(a, b) { return a * b; }");

    // 2. Read file back
    const content = await tools.getRepoFile("calc.js");
    assert.equal(content, "export function multiply(a, b) { return a * b; }");

    // 3. Patch file
    await tools.applyFilePatch("calc.js", "export function multiply(a, b) { return a * b * 2; }");
    const updated = await tools.getRepoFile("calc.js");
    assert.equal(updated, "export function multiply(a, b) { return a * b * 2; }");

    // 4. Run sandboxed node command
    const testJson = await tools.runSandboxTest("node -e \"console.log('Sandbox Alive')\"");
    const testResult = JSON.parse(testJson);
    assert.equal(testResult.exitCode, 0);
    assert.equal(testResult.stdout.includes("Sandbox Alive"), true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("Integration: DiagnoserAgent diagnoses broken package.json missing dependency and verifies fix", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "healops-e2e-"));
  try {
    // 1. Setup a project with a failing test due to missing dependency logic
    const brokenPackageJson = JSON.stringify(
      {
        name: "sample-app",
        version: "1.0.0",
        type: "module",
        scripts: {
          test: "node test.js",
        },
      },
      null,
      2
    );

    // Initial broken test.js
    const brokenTestJs = `
import fs from 'node:fs';
// Intentional test failure: checks for 'status: ok' in config
const config = JSON.parse(fs.readFileSync('./config.json', 'utf-8'));
if (config.status !== 'ready') {
  console.error("Error: Configuration status is not ready! Found:", config.status);
  process.exit(1);
}
console.log("PASS: Configuration status is ready.");
`;

    const brokenConfigJson = JSON.stringify({ status: "broken" }, null, 2);

    await fs.writeFile(path.join(tempDir, "package.json"), brokenPackageJson, "utf-8");
    await fs.writeFile(path.join(tempDir, "test.js"), brokenTestJs, "utf-8");
    await fs.writeFile(path.join(tempDir, "config.json"), brokenConfigJson, "utf-8");

    const sandbox = new Sandbox(tempDir);
    const tools = new AgentTools({ workspaceDir: tempDir, sandbox });

    // Initial test should fail
    const initialRun = await sandbox.runCommand("npm test");
    assert.equal(initialRun.exitCode, 1);
    assert.equal(initialRun.stderr.includes("Configuration status is not ready"), true);

    const agent = new DiagnoserAgent({
      tools,
      apiKey: "mock-groq-key",
      model: "llama-3.3-70b-versatile",
    });

    // Mock Groq API completions to simulate the ReAct loop:
    // Iteration 1: Calls getRepoFile('config.json') -> calls applyFilePatch('config.json', '{"status":"ready"}') -> calls runSandboxTest('npm test')
    let mockStep = 0;
    agent.groq = {
      chat: {
        completions: {
          create: async () => {
            mockStep++;
            if (mockStep === 1) {
              return {
                choices: [
                  {
                    message: {
                      role: "assistant",
                      content: "Inspecting config.json to resolve the failure.",
                      tool_calls: [
                        {
                          id: "call_1",
                          type: "function",
                          function: {
                            name: "getRepoFile",
                            arguments: JSON.stringify({ path: "config.json" }),
                          },
                        },
                      ],
                    },
                  },
                ],
              };
            } else if (mockStep === 2) {
              return {
                choices: [
                  {
                    message: {
                      role: "assistant",
                      content: "Updating status in config.json to 'ready'.",
                      tool_calls: [
                        {
                          id: "call_2",
                          type: "function",
                          function: {
                            name: "applyFilePatch",
                            arguments: JSON.stringify({
                              path: "config.json",
                              newContent: JSON.stringify({ status: "ready" }, null, 2),
                            }),
                          },
                        },
                        {
                          id: "call_3",
                          type: "function",
                          function: {
                            name: "runSandboxTest",
                            arguments: JSON.stringify({ command: "npm test" }),
                          },
                        },
                      ],
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
                      content: "Successfully verified configuration status fix in config.json.",
                      tool_calls: [],
                    },
                  },
                ],
              };
            }
          },
        },
      },
    };

    const remediation = await agent.runRemediation({
      errorLogSnippet: initialRun.stderr,
      branch: "main",
      stepName: "Run npm test",
    });

    assert.equal(remediation.success, true);
    assert.equal(remediation.iterations <= 3, true);
    assert.equal(remediation.modifiedFiles.includes("config.json"), true);
    assert.equal(remediation.testOutput.includes("PASS: Configuration status is ready"), true);

    // Verify file content in workspace was repaired
    const repairedContent = JSON.parse(await fs.readFile(path.join(tempDir, "config.json"), "utf-8"));
    assert.equal(repairedContent.status, "ready");

    // Verify secret scan passes on repaired content
    const scan = scanContentForSecrets(JSON.stringify(repairedContent), "config.json");
    assert.equal(scan.passed, true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
