/**
 * Single-Shot Deterministic Code Remediation Engine powered by Groq.
 * Replaces multi-turn tool calling with a single direct completion (<800 tokens).
 */

import Groq from "groq-sdk";
import { extractFatalErrorLine, getLineWindow } from "../services/logParser.js";
import { sleep } from "../config.js";
import { SRE_SYSTEM_PROMPT, buildRemediationUserPrompt } from "./prompts.js";

export { SRE_SYSTEM_PROMPT, buildRemediationUserPrompt };

/**
 * Build the single-shot prompt specified for deterministic repair.
 * @param {object} params
 * @param {string} params.fatalErrorLine
 * @param {string} params.filePath
 * @param {string} params.lineWindowSnippet
 * @param {boolean} [params.isFullFile=true]
 * @returns {string}
 */
export function buildSingleShotPrompt({ fatalErrorLine, filePath, lineWindowSnippet, isFullFile = true }) {
  if (isFullFile) {
    return `${SRE_SYSTEM_PROMPT}

Target File: ${filePath}
The build failed with this error:
${fatalErrorLine}

Here is the code around the failure in '${filePath}':
---
${lineWindowSnippet}
---

TASK:
Provide the complete, updated file content for '${filePath}' to fix the error.
Return ONLY the raw file content. Do not include markdown code fences (no \`\`\`), conversational filler, or explanations.`;
  }

  return `${SRE_SYSTEM_PROMPT}

${buildRemediationUserPrompt({ filePath, errorMessage: fatalErrorLine, lineWindowSnippet })}`;
}


/**
 * Clean markdown code fences from raw LLM output if present.
 * @param {string} rawContent
 * @returns {string}
 */
export function cleanRawCodeOutput(rawContent) {
  if (!rawContent) return "";
  let cleaned = rawContent.trim();
  cleaned = cleaned.replace(/^```[a-zA-Z0-9_-]*\r?\n/, "");
  cleaned = cleaned.replace(/\r?\n```\s*$/, "");
  return cleaned.trim();
}

/**
 * Surgically apply SEARCH/REPLACE blocks to file content.
 * @param {string} fullContent
 * @param {string} patchText
 * @returns {string|null}
 */
export function applySearchReplace(fullContent, patchText) {
  if (!fullContent || !patchText) return null;
  const regex = /<<<<<<< SEARCH\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n>>>>>>> REPLACE/g;
  let updated = fullContent;
  let matches = 0;
  let m;

  while ((m = regex.exec(patchText)) !== null) {
    const search = m[1];
    const replace = m[2];
    if (updated.includes(search)) {
      updated = updated.replace(search, replace);
      matches++;
    } else if (updated.includes(search.trim())) {
      updated = updated.replace(search.trim(), replace.trim());
      matches++;
    }
  }

  return matches > 0 ? updated : null;
}


export class DiagnoserAgent {
  /**
   * @param {object} params
   * @param {string} [params.apiKey]
   * @param {string} [params.model]
   * @param {import("./tools.js").AgentTools} params.tools
   * @param {object} [params.logger]
   */
  constructor({
    apiKey,
    model,
    tools,
    logger = console,
  }) {
    this.tools = tools;
    this.logger = logger;
    this.apiKey = apiKey || process.env.GROQ_API_KEY;
    this.model = model || process.env.GROQ_MODEL || "llama-3.1-8b-instant";

    if (this.apiKey) {
      this.groq = new Groq({ apiKey: this.apiKey });
    }
  }

  /**
   * Request a single-shot code repair from Groq.
   * @param {object} params
   * @param {string} params.fatalErrorLine
   * @param {string} params.filePath
   * @param {string} params.lineWindowSnippet
   * @returns {Promise<string>} Cleaned fixed file content
   */
  async generateFix({ fatalErrorLine, filePath, lineWindowSnippet }) {
    if (!this.groq) {
      throw new Error("GROQ_API_KEY missing from environment.");
    }

    const prompt = buildRemediationUserPrompt({
      filePath,
      errorMessage: fatalErrorLine,
      lineWindowSnippet,
    });

    let completion;
    try {
      completion = await this.groq.chat.completions.create({
        model: this.model,
        messages: [
          { role: "system", content: SRE_SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        temperature: 0.1,
      });
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
        completion = await this.groq.chat.completions.create({
          model: this.model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.1,
        });
      } else {
        throw groqErr;
      }
    }

    const raw = completion?.choices?.[0]?.message?.content || "";
    return cleanRawCodeOutput(raw);
  }

  /**
   * Run the single-shot deterministic remediation pipeline:
   * 1. Generates fixed code via single direct completion
   * 2. Overwrites the target file in the sandbox workspace
   * 3. Runs verification sandbox test once
   *
   * @param {object} params
   * @param {string} [params.fatalErrorLine]
   * @param {string} [params.filePath]
   * @param {string} [params.lineWindowSnippet]
   * @param {object} [params.culprit]
   * @param {string} [params.errorLogSnippet]
   * @param {string} [params.testCommand="npm test"]
   * @returns {Promise<{ success: boolean, rootCause: string, modifiedFiles: string[], fixedCode?: string, testCommand: string, testOutput: string, iterations: number }>}
   */
  async runRemediation({
    fatalErrorLine,
    filePath,
    lineWindowSnippet,
    culprit = null,
    errorLogSnippet = "",
    testCommand = "npm test",
  }) {
    const targetFile = filePath || culprit?.targetFile;
    const errorLine = fatalErrorLine || (errorLogSnippet ? extractFatalErrorLine(errorLogSnippet) : "CI Build / Test Failure");
    const windowSnippet = lineWindowSnippet || culprit?.lineWindow || "";

    if (!targetFile) {
      this.logger.warn("No culprit target file identified. Single-shot remediation aborted.");
      return {
        success: false,
        rootCause: "No culprit file identified from build logs.",
        modifiedFiles: [],
        testCommand,
        testOutput: "No culprit file identified.",
        iterations: 1,
      };
    }

    this.logger.info(`[Groq (${this.model})] Requesting single-shot fix for '${targetFile}'...`);
    const fixedCode = await this.generateFix({
      fatalErrorLine: errorLine,
      filePath: targetFile,
      lineWindowSnippet: windowSnippet,
    });

    if (!fixedCode) {
      this.logger.warn("Groq returned an empty response. Aborting single-shot remediation.");
      return {
        success: false,
        rootCause: "Empty repair returned by LLM.",
        modifiedFiles: [],
        testCommand,
        testOutput: "Empty patch received.",
        iterations: 1,
      };
    }

    // 1. Overwrite target file with returned code
    await this.tools.applyFilePatch(targetFile, fixedCode);

    // 2. Run workspace test/build command once
    this.logger.info(`Executing single-shot verification command: '${testCommand}'...`);
    const testResultJson = await this.tools.runSandboxTest(testCommand);
    const testResult = JSON.parse(testResultJson);

    if (testResult.exitCode === 0) {
      this.logger.info(`✅ Single-shot verification passed on '${targetFile}'!`);
      return {
        success: true,
        rootCause: `Single-shot remediation resolved error in \`${targetFile}\`: \`${errorLine}\``,
        modifiedFiles: [targetFile],
        fixedCode,
        testCommand,
        testOutput: testResult.stdout || "Verification test passed with exit code 0.",
        iterations: 1,
      };
    } else {
      const failureOutput = (testResult.stderr || testResult.stdout || "").trim();
      this.logger.warn(
        `❌ Single-shot remediation was unsuccessful (exit code: ${testResult.exitCode}). Verification output:\n${failureOutput.slice(0, 1000)}`
      );
      return {
        success: false,
        rootCause: `Single-shot remediation failed verification in \`${targetFile}\`.`,
        modifiedFiles: [targetFile],
        fixedCode,
        testCommand,
        testOutput: testResult.stderr || testResult.stdout || `Failed with exit code ${testResult.exitCode}`,
        iterations: 1,
      };
    }
  }

  /**
   * Run multi-file deterministic remediation pipeline:
   * Iterates through all detected culprit files, applies surgical patches,
   * paces API requests with sleep, and executes single workspace verification once.
   *
   * @param {object} params
   * @param {Array<{ targetFile: string, lineNum: number, errors: string[] }>} params.culprits
   * @param {string} [params.testCommand="npm test"]
   * @param {number} [params.delayMs=2000]
   * @returns {Promise<{ success: boolean, rootCause: string, modifiedFiles: string[], testCommand: string, testOutput: string, iterations: number }>}
   */
  async runMultiFileRemediation({
    culprits = [],
    testCommand = "npm test",
    delayMs = 2000,
  }) {
    if (!culprits || culprits.length === 0) {
      this.logger.warn("No culprit files provided for multi-file remediation.");
      return {
        success: false,
        rootCause: "No culprit files identified.",
        modifiedFiles: [],
        testCommand,
        testOutput: "No culprit files identified.",
        iterations: 1,
      };
    }

    const modifiedFiles = [];
    const rootCauses = [];
    const maxFiles = Math.min(culprits.length, 30);

    this.logger.info(`🛠️ Beginning multi-file remediation on all ${maxFiles} broken file(s)...`);

    for (let i = 0; i < maxFiles; i++) {
      const culprit = culprits[i];
      const targetFile = culprit.targetFile;
      const errorText = Array.isArray(culprit.errors) && culprit.errors.length > 0
        ? culprit.errors.slice(0, 5).join("\n")
        : `CI failure at line ${culprit.lineNum}`;

      try {
        const fullContent = await this.tools.getRepoFile(targetFile);
        if (!fullContent || fullContent.startsWith("Error:")) {
          this.logger.warn(`Could not read '${targetFile}'. Skipping.`);
          continue;
        }

        const linesCount = fullContent.split("\n").length;
        const isFullFile = linesCount <= 120;
        let snippet = "";

        if (isFullFile) {
          snippet = fullContent;
        } else {
          snippet = getLineWindow(fullContent, culprit.lineNum || 1, 15);
        }

        this.logger.info(`[${i + 1}/${maxFiles}] [Groq (${this.model})] Patching '${targetFile}' (${culprit.errors?.length || 1} error(s))...`);

        const prompt = buildRemediationUserPrompt({
          filePath: targetFile,
          errorMessage: errorText,
          lineWindowSnippet: snippet,
        });

        let completion;
        let attempts = 0;
        const maxAttempts = 3;

        while (attempts < maxAttempts) {
          attempts++;
          try {
            completion = await this.groq.chat.completions.create({
              model: this.model,
              messages: [
                { role: "system", content: SRE_SYSTEM_PROMPT },
                { role: "user", content: prompt },
              ],
              temperature: 0.1,
            });
            break;
          } catch (groqErr) {
            const isConnectionOrRateLimit =
              groqErr.status === 429 ||
              groqErr.code === "ECONNRESET" ||
              groqErr.message?.toLowerCase().includes("connection error") ||
              groqErr.message?.toLowerCase().includes("rate limit") ||
              groqErr.message?.toLowerCase().includes("timeout");

            if (isConnectionOrRateLimit && attempts < maxAttempts) {
              const backoff = attempts * 3000;
              this.logger.warn(
                `[Groq] Connection/rate-limit error on '${targetFile}' (${groqErr.message}). Retrying in ${backoff / 1000}s (attempt ${attempts}/${maxAttempts})...`
              );
              await sleep(backoff);
              continue;
            }

            const isModelNotFound =
              groqErr.status === 404 ||
              groqErr.code === "model_not_found" ||
              groqErr.message?.includes("model_not_found") ||
              groqErr.message?.includes("does not exist or you do not have access to it");

            if (isModelNotFound && this.model !== "openai/gpt-oss-120b") {
              this.model = "openai/gpt-oss-120b";
              this.logger.warn(`[Groq] Fallback to model '${this.model}'...`);
              continue;
            }

            this.logger.error(`Groq error while patching '${targetFile}': ${groqErr.message}`);
            break;
          }
        }

        const rawOutput = completion?.choices?.[0]?.message?.content || "";
        const cleaned = cleanRawCodeOutput(rawOutput);

        if (!cleaned) {
          this.logger.warn(`Empty response for '${targetFile}'. Skipping.`);
          continue;
        }

        let finalCode = "";
        const searchReplaced = applySearchReplace(fullContent, cleaned);
        if (searchReplaced) {
          finalCode = searchReplaced;
        } else if (isFullFile) {
          finalCode = cleaned;
        } else {
          if (cleaned.length > fullContent.length * 0.7) {
            finalCode = cleaned;
          } else {
            finalCode = fullContent.replace(snippet, cleaned);
            if (!fullContent.includes(snippet)) {
              finalCode = cleaned;
            }
          }
        }

        await this.tools.applyFilePatch(targetFile, finalCode);
        modifiedFiles.push(targetFile);
        rootCauses.push(`- \`${targetFile}\`: resolved ${culprit.errors?.length || 1} error(s)`);

        // Rate-limit safety pause before next file
        if (i < maxFiles - 1 && delayMs > 0) {
          await sleep(delayMs);
        }
      } catch (fileErr) {
        this.logger.error(`Failed to patch '${targetFile}': ${fileErr.message}`);
      }
    }

    if (modifiedFiles.length === 0) {
      return {
        success: false,
        rootCause: "No files were successfully patched.",
        modifiedFiles: [],
        testCommand,
        testOutput: "No patches applied.",
        iterations: 1,
      };
    }

    // Attempt auto-fix on lint commands if supported
    if (testCommand.includes("lint")) {
      const prefixMatch = testCommand.match(/--prefix\s+([\w.-]+)/);
      const prefix = prefixMatch ? `--prefix ${prefixMatch[1]}` : "";
      try {
        await this.tools.runSandboxTest(`npm run lint ${prefix} --if-present -- --fix`);
      } catch {
        // Proceed to strict verification
      }
    }

    this.logger.info(`Executing verification command on all ${modifiedFiles.length} patched file(s): '${testCommand}'...`);
    const testResultJson = await this.tools.runSandboxTest(testCommand);
    const testResult = JSON.parse(testResultJson);

    if (testResult.exitCode === 0) {
      this.logger.info(`✅ Multi-file verification passed for ${modifiedFiles.length} file(s)!`);
      return {
        success: true,
        rootCause: `Automated remediation resolved errors across ${modifiedFiles.length} file(s):\n${rootCauses.join("\n")}`,
        modifiedFiles,
        testCommand,
        testOutput: testResult.stdout || "Verification test passed with exit code 0.",
        iterations: 1,
      };
    } else {
      const failureOutput = (testResult.stderr || testResult.stdout || "").trim();
      this.logger.warn(
        `❌ Multi-file remediation failed verification (exit code: ${testResult.exitCode}). Output:\n${failureOutput.slice(0, 1000)}`
      );
      return {
        success: false,
        rootCause: `Remediation failed verification across ${modifiedFiles.length} file(s).`,
        modifiedFiles,
        testCommand,
        testOutput: failureOutput,
        iterations: 1,
      };
    }
  }
}

