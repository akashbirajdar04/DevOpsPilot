/**
 * Autonomous ReAct Agent Loop for CI Diagnosis and Repair powered by Groq.
 */

import Groq from "groq-sdk";
import { SRE_SYSTEM_PROMPT, GROQ_TOOL_DECLARATIONS } from "./prompts.js";

export class DiagnoserAgent {
  /**
   * @param {object} params
   * @param {string} [params.apiKey] - Groq API Key
   * @param {string} [params.model] - Groq Model ID
   * @param {import("./tools.js").AgentTools} params.tools
   * @param {number} [params.maxRetries=10]
   * @param {object} [params.logger]
   */
  constructor({
    apiKey,
    model,
    tools,
    maxRetries = 10,
    logger = console,
  }) {
    this.tools = tools;
    this.maxRetries = maxRetries;
    this.logger = logger;

    this.apiKey = apiKey || process.env.GROQ_API_KEY;
    this.model = model || process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

    if (this.apiKey) {
      this.groq = new Groq({ apiKey: this.apiKey });
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
      case "listFiles":
        return await this.tools.listFiles(args.directory || "");
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
   * Run the autonomous remediation loop using Groq.
   * @param {object} context
   * @param {string} context.errorLogSnippet - ANSI-cleaned error log window
   * @param {string} context.branch - Failing head branch name
   * @param {string} [context.stepName]
   * @returns {Promise<{ success: boolean, iterations: number, rootCause: string, modifiedFiles: string[], testCommand: string, testOutput: string }>}
   */
  async runRemediation({ errorLogSnippet, branch, stepName = "Build / Test" }) {
    if (!this.groq) {
      this.logger.warn("GROQ_API_KEY is not set. Cannot run Groq diagnostic loop.");
      return {
        success: false,
        iterations: 0,
        rootCause: "GROQ_API_KEY missing from environment.",
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

1. Inspect the failing source file(s) and error locations identified above using 'getRepoFile'.
2. Formulate and apply a surgical code repair using 'applyFilePatch'.
3. Verify your fix passes by running 'runSandboxTest' with the appropriate test or lint command.`;

    const messages = [
      { role: "system", content: SRE_SYSTEM_PROMPT },
      { role: "user", content: initialPrompt },
    ];

    let iteration = 0;
    let rootCause = "Automated diagnosis and remediation completed via Groq.";

    while (iteration < this.maxRetries) {
      iteration++;
      this.logger.info(`[Groq (${this.model})] Starting remediation iteration ${iteration}/${this.maxRetries}...`);

      this._pruneGroqMessages(messages, 12000);

      let completion;
      let delay = 4000;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          completion = await this.groq.chat.completions.create({
            model: this.model,
            messages,
            tools: GROQ_TOOL_DECLARATIONS,
            tool_choice: "auto",
            temperature: 0.1,
          });
          break;
        } catch (groqErr) {
          const isModelNotFound =
            groqErr.status === 404 ||
            groqErr.code === "model_not_found" ||
            groqErr.message?.includes("model_not_found") ||
            groqErr.message?.includes("does not exist or you do not have access to it");

          if (isModelNotFound && this.model !== "openai/gpt-oss-120b") {
            this.logger.warn(
              `[Groq] Model '${this.model}' is not accessible on this API key. Falling back to 'openai/gpt-oss-120b'...`
            );
            this.model = "openai/gpt-oss-120b";
            continue;
          }

          const isRateLimit =
            groqErr.status === 413 ||
            groqErr.status === 429 ||
            groqErr.message?.includes("TPM") ||
            groqErr.message?.includes("tokens per minute") ||
            groqErr.message?.includes("rate_limit");

          if (isRateLimit && attempt < 3) {
            this.logger.warn(
              `[Groq] TPM limit reached. Pruning context and waiting ${delay / 1000}s (Attempt ${attempt}/3)...`
            );
            this._pruneGroqMessages(messages, 6000);
            await new Promise((r) => setTimeout(r, delay));
            delay *= 1.5;
          } else {
            throw groqErr;
          }
        }
      }

      const message = completion?.choices?.[0]?.message;
      if (!message) break;

      messages.push(message);

      if (message.content) {
        rootCause = message.content;
      }

      const toolCalls = message.tool_calls || [];
      if (toolCalls.length === 0) {
        this.logger.info("[Groq] Agent provided final response without further tool invocations.");
        break;
      }

      for (const call of toolCalls) {
        let args = {};
        try {
          args = typeof call.function.arguments === "string" ? JSON.parse(call.function.arguments) : call.function.arguments;
        } catch {
          args = {};
        }

        const result = await this.executeTool(call.function.name, args);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: typeof result === "string" ? result : JSON.stringify(result),
        });
      }

      // Check if sandbox test passed AND code changes were made
      if (
        this.tools.modifiedFiles.size > 0 &&
        this.tools.lastTestResult &&
        this.tools.lastTestResult.exitCode === 0
      ) {
        this.logger.info(`[Groq] Verification passed with ${this.tools.modifiedFiles.size} patched file(s) on iteration ${iteration}!`);
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

    const success = Boolean(
      this.tools.modifiedFiles.size > 0 &&
      this.tools.lastTestResult &&
      this.tools.lastTestResult.exitCode === 0
    );
    return {
      success,
      iterations: iteration,
      rootCause,
      modifiedFiles: Array.from(this.tools.modifiedFiles.keys()),
      testCommand: this.tools.lastTestCommand || "npm test",
      testOutput: this.tools.lastTestResult?.stderr || this.tools.lastTestResult?.stdout || "Test failed.",
    };
  }

  /**
   * Prune earlier tool messages to stay strictly within Groq's 8,000 TPM limit.
   */
  _pruneGroqMessages(messages, maxChars = 12000) {
    let totalLength = messages.reduce(
      (sum, m) => sum + (typeof m.content === "string" ? m.content.length : 0),
      0
    );
    if (totalLength <= maxChars) return;

    for (let i = 2; i < messages.length - 1; i++) {
      if (messages[i].role === "tool" && messages[i].content && messages[i].content.length > 300) {
        messages[i].content = messages[i].content.slice(0, 300) + "\n... [Pruned to stay within TPM token limits]";
        totalLength = messages.reduce(
          (sum, m) => sum + (typeof m.content === "string" ? m.content.length : 0),
          0
        );
        if (totalLength <= maxChars) break;
      }
    }
  }
}
