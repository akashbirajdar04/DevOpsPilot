/**
 * Gemini 2.5 Flash Autonomous ReAct Agent Loop for CI Diagnosis and Repair.
 */

import { GoogleGenAI } from "@google/genai";
import { SRE_SYSTEM_PROMPT, TOOL_DECLARATIONS } from "./prompts.js";

export class DiagnoserAgent {
  /**
   * @param {object} params
   * @param {string} [params.apiKey] - Google AI Studio API Key
   * @param {string} [params.model="gemini-2.5-flash"]
   * @param {import("./tools.js").AgentTools} params.tools
   * @param {number} [params.maxRetries=3]
   * @param {object} [params.logger]
   */
  constructor({ apiKey, model = "gemini-2.5-flash", tools, maxRetries = 3, logger = console }) {
    this.apiKey = apiKey || process.env.GEMINI_API_KEY;
    this.model = model;
    this.tools = tools;
    this.maxRetries = maxRetries;
    this.logger = logger;

    if (this.apiKey) {
      this.ai = new GoogleGenAI({ apiKey: this.apiKey });
    }
  }

  /**
   * Execute tool function requested by the LLM.
   * @param {string} name
   * @param {object} args
   * @returns {Promise<any>}
   */
  async executeTool(name, args) {
    this.logger.info(`Agent invoking tool: ${name}(${JSON.stringify(args)})`);
    switch (name) {
      case "getRepoFile":
        return await this.tools.getRepoFile(args.path);
      case "applyFilePatch":
        return await this.tools.applyFilePatch(args.path, args.newContent);
      case "runSandboxTest":
        return await this.tools.runSandboxTest(args.command);
      default:
        return `Error: Unknown tool function '${name}'.`;
    }
  }

  /**
   * Run the autonomous remediation loop.
   * @param {object} context
   * @param {string} context.errorLogSnippet - ANSI-cleaned error log window
   * @param {string} context.branch - Failing head branch name
   * @param {string} [context.stepName]
   * @returns {Promise<{ success: boolean, iterations: number, rootCause: string, modifiedFiles: string[], testCommand: string, testOutput: string }>}
   */
  async runRemediation({ errorLogSnippet, branch, stepName = "Build / Test" }) {
    if (!this.ai) {
      this.logger.warn("GEMINI_API_KEY is not set. Cannot run LLM diagnostic loop.");
      return {
        success: false,
        iterations: 0,
        rootCause: "GEMINI_API_KEY missing from environment.",
        modifiedFiles: [],
        testCommand: "",
        testOutput: "",
      };
    }

    const initialPrompt = `CI/CD Failure Report on branch '${branch}'.
Failing Step: ${stepName}

### Extracted Failure Log:
\`\`\`text
${errorLogSnippet}
\`\`\`

Inspect the relevant code files using 'getRepoFile', formulate and apply a targeted fix using 'applyFilePatch', and verify the fix passes by running 'runSandboxTest'.`;

    const contents = [
      {
        role: "user",
        parts: [{ text: initialPrompt }],
      },
    ];

    let iteration = 0;
    let rootCause = "Automated diagnosis and remediation completed.";

    while (iteration < this.maxRetries) {
      iteration++;
      this.logger.info(`Starting remediation iteration ${iteration}/${this.maxRetries}...`);

      const response = await this.ai.models.generateContent({
        model: this.model,
        contents,
        config: {
          systemInstruction: SRE_SYSTEM_PROMPT,
          temperature: 0.1,
          tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
        },
      });

      // Extract response text and candidate function calls
      const candidate = response.candidates?.[0];
      const modelContent = candidate?.content;
      if (modelContent) {
        contents.push(modelContent);
      }

      const functionCalls = response.functionCalls || [];
      const textResponse = response.text || "";
      if (textResponse) {
        rootCause = textResponse;
      }

      if (functionCalls.length === 0) {
        this.logger.info("Agent provided response without further tool invocations.");
        break;
      }

      // Execute all tool calls emitted in this step
      const functionResponseParts = [];
      for (const call of functionCalls) {
        const result = await this.executeTool(call.name, call.args || {});
        functionResponseParts.push({
          functionResponse: {
            name: call.name,
            response: { output: result },
          },
        });
      }

      contents.push({
        role: "user",
        parts: functionResponseParts,
      });

      // Check if sandbox test passed
      if (this.tools.lastTestResult && this.tools.lastTestResult.exitCode === 0) {
        this.logger.info(`Verification passed on iteration ${iteration}!`);
        return {
          success: true,
          iterations: iteration,
          rootCause,
          modifiedFiles: Array.from(this.tools.modifiedFiles.keys()),
          testCommand: this.tools.lastTestCommand || "npm test",
          testOutput: this.tools.lastTestResult.stdout || "Tests passed.",
        };
      }
    }

    const success = Boolean(this.tools.lastTestResult && this.tools.lastTestResult.exitCode === 0);
    return {
      success,
      iterations: iteration,
      rootCause,
      modifiedFiles: Array.from(this.tools.modifiedFiles.keys()),
      testCommand: this.tools.lastTestCommand || "npm test",
      testOutput: this.tools.lastTestResult?.stderr || this.tools.lastTestResult?.stdout || "Test failed.",
    };
  }
}
