/**
 * Single-Shot Deterministic Code Remediation Engine powered by Groq.
 * Replaces multi-turn tool calling with a single direct completion (<800 tokens).
 */

import Groq from "groq-sdk";
import {
  extractFatalErrorLine,
  getLineWindow,
  extractCodeContext,
  diagnoseLogErrors,
  extractVerificationDiagnostics,
} from "../services/logParser.js";
import { sleep } from "../config.js";
import { SRE_SYSTEM_PROMPT, buildRemediationUserPrompt } from "./prompts.js";
import { DeterministicFixer } from "../services/deterministicFixer.js";
import { validatePatchOutput, validateModifiedFile } from "./validator.js";

export { SRE_SYSTEM_PROMPT, buildRemediationUserPrompt, validatePatchOutput, validateModifiedFile };

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
 * Clean markdown code fences and conversational filler from raw LLM output.
 * Strips reasoning/think tags, extracts explicit SEARCH/REPLACE or diff blocks.
 * @param {string} rawContent
 * @returns {string}
 */
export function cleanRawCodeOutput(rawContent) {
  if (!rawContent || typeof rawContent !== "string") return "";
  let text = rawContent.trim();

  // 1. Strip thinking tags: <think>...</think>
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

  // 2. If SEARCH/REPLACE blocks exist anywhere in the text, extract from first SEARCH to last REPLACE
  const searchIdx = text.indexOf("<<<<<<< SEARCH");
  const replaceIdx = text.lastIndexOf(">>>>>>> REPLACE");
  if (searchIdx !== -1 && replaceIdx !== -1 && replaceIdx > searchIdx) {
    return text.substring(searchIdx, replaceIdx + ">>>>>>> REPLACE".length).trim();
  }

  // 3. If unified diff blocks exist (--- and +++ and @@)
  if (text.includes("@@") && (text.includes("---") || text.includes("+++"))) {
    const fencedDiff = text.match(/```(?:diff|patch)?\s*\n([\s\S]*?)\n```/i);
    if (fencedDiff) {
      return fencedDiff[1].trim();
    }
    const atIdx = text.indexOf("@@ -");
    if (atIdx !== -1) {
      return text.substring(atIdx).replace(/\r?\n```\s*$/, "").trim();
    }
  }

  // 4. If code is wrapped in markdown code fences, extract the fenced content
  const fenceMatch = text.match(/^```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n```\s*$/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }

  // Strip generic outer code fences
  text = text.replace(/^```[a-zA-Z0-9_-]*\r?\n/, "");
  text = text.replace(/\r?\n```\s*$/, "");

  return text.trim();
}

/**
 * Detect if LLM generated truncated code or omitted-line placeholders.
 * @param {string} code
 * @returns {boolean}
 */
export function isTruncatedCode(code) {
  if (!code) return false;
  return /(\/\/|\/\*)\s*(\[?.*(?:remaining lines|rest of code|code omitted|token limits))/i.test(code);
}

/**
 * Surgically apply unified diff hunks (@@ -start,len +start,len @@) to file content.
 * @param {string} fullContent
 * @param {string} diffText
 * @returns {string|null}
 */
export function applyUnifiedDiff(fullContent, diffText) {
  if (!fullContent || !diffText) return null;
  const isCrlf = fullContent.includes("\r\n");
  const normalizedContent = fullContent.replace(/\r\n/g, "\n");
  const normalizedDiff = diffText.replace(/\r\n/g, "\n");

  const hunkRegex = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@[^\n]*\n([\s\S]*?)(?=(?:\n@@ -\d+|$))/g;
  let updated = normalizedContent;
  let matches = 0;
  let m;

  while ((m = hunkRegex.exec(normalizedDiff)) !== null) {
    const hunkBody = m[3];
    const hunkLines = hunkBody.split("\n");
    const searchLines = [];
    const replaceLines = [];

    for (const line of hunkLines) {
      if (line.startsWith("-")) {
        searchLines.push(line.slice(1));
      } else if (line.startsWith("+")) {
        replaceLines.push(line.slice(1));
      } else if (line.startsWith(" ")) {
        searchLines.push(line.slice(1));
        replaceLines.push(line.slice(1));
      } else if (line === "") {
        searchLines.push("");
        replaceLines.push("");
      }
    }

    if (searchLines.length === 0) continue;

    const searchStr = searchLines.join("\n");
    const replaceStr = replaceLines.join("\n");

    if (updated.includes(searchStr)) {
      updated = updated.replace(searchStr, replaceStr);
      matches++;
    } else {
      // Fuzzy line match ignoring leading/trailing whitespace
      const contentLines = updated.split("\n");
      let foundIdx = -1;
      for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
        const slice = contentLines.slice(i, i + searchLines.length).map((l) => l.trim());
        if (slice.every((line, idx) => line === searchLines[idx].trim())) {
          foundIdx = i;
          break;
        }
      }
      if (foundIdx !== -1) {
        contentLines.splice(foundIdx, searchLines.length, replaceStr);
        updated = contentLines.join("\n");
        matches++;
      }
    }
  }

  if (matches > 0) {
    return isCrlf ? updated.replace(/\n/g, "\r\n") : updated;
  }
  return null;
}

/**
 * Parse SEARCH/REPLACE blocks using a strict state machine rather than greedy regular expressions.
 * Accurately extracts multiple blocks, deletions (empty replacement), and rejects unclosed or malformed blocks.
 *
 * @param {string} patchText
 * @returns {{ success: boolean, blocks?: Array<{ search: string, replace: string, startLine: number }>, reason?: string }}
 */
export function parseSearchReplaceBlocks(patchText) {
  if (!patchText || typeof patchText !== "string") {
    return { success: false, reason: "Empty patch received." };
  }

  const lines = patchText.replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let state = "IDLE"; // "IDLE" | "IN_SEARCH" | "IN_REPLACE"
  let currentSearch = [];
  let currentReplace = [];
  let blockStartLine = -1;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    if (trimmed.startsWith("<<<<<<< SEARCH")) {
      if (state !== "IDLE") {
        return {
          success: false,
          reason: `Malformed SEARCH_REPLACE at line ${i + 1}: unexpected <<<<<<< SEARCH marker before completing previous block.`,
        };
      }
      state = "IN_SEARCH";
      currentSearch = [];
      currentReplace = [];
      blockStartLine = i + 1;
    } else if (trimmed.startsWith("=======")) {
      if (state !== "IN_SEARCH") {
        return {
          success: false,
          reason: `Malformed SEARCH_REPLACE at line ${i + 1}: unexpected ======= marker outside of search block.`,
        };
      }
      state = "IN_REPLACE";
    } else if (trimmed.startsWith(">>>>>>> REPLACE")) {
      if (state !== "IN_REPLACE") {
        return {
          success: false,
          reason: `Malformed SEARCH_REPLACE at line ${i + 1}: unexpected >>>>>>> REPLACE marker before ======= divider.`,
        };
      }
      const searchStr = currentSearch.join("\n");
      const replaceStr = currentReplace.join("\n");

      if (searchStr.length === 0 && searchStr.trim() === "") {
        return {
          success: false,
          reason: `Malformed SEARCH_REPLACE starting at line ${blockStartLine}: SEARCH block cannot be empty.`,
        };
      }

      blocks.push({
        search: searchStr,
        replace: replaceStr,
        startLine: blockStartLine,
      });
      state = "IDLE";
    } else {
      if (state === "IN_SEARCH") {
        currentSearch.push(rawLine);
      } else if (state === "IN_REPLACE") {
        currentReplace.push(rawLine);
      }
    }
  }

  if (state !== "IDLE") {
    return {
      success: false,
      reason: `Malformed SEARCH_REPLACE starting at line ${blockStartLine}: block is incomplete (missing closing marker).`,
    };
  }

  if (blocks.length === 0) {
    return {
      success: false,
      reason: "No valid SEARCH_REPLACE blocks found in patch.",
    };
  }

  return {
    success: true,
    blocks,
  };
}

/**
 * Locate a search snippet uniquely within file content.
 * Enforces strict single-match semantics: rejects non-matching code and ambiguous multiple matches.
 *
 * @param {string} content
 * @param {string} rawSearch
 * @param {string} rawReplace
 * @returns {{ found: boolean, start?: number, end?: number, replace?: string, reason?: string }}
 */
function findMatchInContent(content, rawSearch, rawReplace) {
  if (!rawSearch || rawSearch.length === 0) {
    return { found: false, reason: "Search block is empty." };
  }

  // 1. Exact match
  // 1a. If deletion (rawReplace === ""), prefer exact line deletion with trailing newline
  if (rawReplace === "" && content.includes(rawSearch + "\n")) {
    const firstIdx = content.indexOf(rawSearch + "\n");
    const secondIdx = content.indexOf(rawSearch + "\n", firstIdx + 1);
    if (secondIdx !== -1) {
      return { found: false, reason: "Ambiguous match (search block matches multiple locations in file)." };
    }
    return { found: true, start: firstIdx, end: firstIdx + rawSearch.length + 1, replace: "" };
  }

  // 1b. Exact substring match
  if (content.includes(rawSearch)) {
    const firstIdx = content.indexOf(rawSearch);
    const secondIdx = content.indexOf(rawSearch, firstIdx + 1);
    if (secondIdx !== -1) {
      return { found: false, reason: "Ambiguous match (search block matches multiple locations in file)." };
    }
    return { found: true, start: firstIdx, end: firstIdx + rawSearch.length, replace: rawReplace };
  }

  // 2. Line numbers stripped match
  const strippedSearch = rawSearch.replace(/^\s*\d+[:|]?\s*/gm, "");
  const strippedReplace = rawReplace.replace(/^\s*\d+[:|]?\s*/gm, "");

  if (strippedSearch !== rawSearch) {
    if (strippedReplace === "" && content.includes(strippedSearch + "\n")) {
      const firstIdx = content.indexOf(strippedSearch + "\n");
      const secondIdx = content.indexOf(strippedSearch + "\n", firstIdx + 1);
      if (secondIdx !== -1) {
        return { found: false, reason: "Ambiguous match after stripping line numbers." };
      }
      return { found: true, start: firstIdx, end: firstIdx + strippedSearch.length + 1, replace: "" };
    }

    if (content.includes(strippedSearch)) {
      const firstIdx = content.indexOf(strippedSearch);
      const secondIdx = content.indexOf(strippedSearch, firstIdx + 1);
      if (secondIdx !== -1) {
        return { found: false, reason: "Ambiguous match after stripping line numbers." };
      }
      return { found: true, start: firstIdx, end: firstIdx + strippedSearch.length, replace: strippedReplace };
    }
  }

  // 3. Trimmed exact match (only if search is non-trivial and unique)
  const trimmedSearch = (strippedSearch || rawSearch).trim();
  const trimmedReplace = (strippedReplace || rawReplace).trim();
  if (trimmedSearch.length > 0 && content.includes(trimmedSearch)) {
    const firstIdx = content.indexOf(trimmedSearch);
    const secondIdx = content.indexOf(trimmedSearch, firstIdx + 1);
    if (secondIdx !== -1) {
      return { found: false, reason: "Ambiguous match (trimmed search matches multiple locations in file)." };
    }
    return { found: true, start: firstIdx, end: firstIdx + trimmedSearch.length, replace: trimmedReplace };
  }

  // 4. Line-by-line whitespace-flexible match
  const searchLines = (strippedSearch || rawSearch).split("\n");
  const contentLines = content.split("\n");

  if (searchLines.length > 0 && searchLines.length <= contentLines.length) {
    const matchingIndices = [];
    for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
      let isMatch = true;
      for (let j = 0; j < searchLines.length; j++) {
        if (contentLines[i + j].trim() !== searchLines[j].trim()) {
          isMatch = false;
          break;
        }
      }
      if (isMatch) {
        matchingIndices.push(i);
      }
    }

    if (matchingIndices.length > 1) {
      return { found: false, reason: "Ambiguous match (fuzzy line search matched multiple locations in file)." };
    }

    if (matchingIndices.length === 1) {
      const foundIdx = matchingIndices[0];
      let charStart = 0;
      for (let i = 0; i < foundIdx; i++) {
        charStart += contentLines[i].length + 1;
      }

      let charEnd = charStart;
      for (let i = 0; i < searchLines.length; i++) {
        charEnd += contentLines[foundIdx + i].length;
        if (foundIdx + i < contentLines.length - 1) {
          charEnd += 1;
        }
      }

      const baseIndent = contentLines[foundIdx].match(/^\s*/)?.[0] || "";
      const replaceLines = (strippedReplace || rawReplace).split("\n");
      const indentedReplace = replaceLines
        .map((l) => (l.trim() ? baseIndent + l.trimStart() : ""))
        .join("\n");

      return {
        found: true,
        start: charStart,
        end: charEnd,
        replace: strippedReplace === "" ? "" : indentedReplace,
      };
    }
  }

  return { found: false, reason: "Search text does not match target file." };
}

/**
 * Surgically apply SEARCH/REPLACE blocks or unified diff to file content with detailed reporting.
 * - Parses multiple blocks independently
 * - Validates that every search block uniquely matches before modifying
 * - Validates that replacement blocks do not overlap
 * - Applies all blocks atomically from bottom to top
 * - Returns structured error reason if matching or validation fails
 *
 * @param {string} fullContent
 * @param {string} patchText
 * @returns {{ success: boolean, code: string|null, reason: string|null, blocksCount: number }}
 */
export function applySearchReplaceDetailed(fullContent, patchText) {
  if (!fullContent || typeof fullContent !== "string") {
    return { success: false, code: null, reason: "Original file content is empty.", blocksCount: 0 };
  }
  if (!patchText || typeof patchText !== "string") {
    return { success: false, code: null, reason: "Patch text is empty.", blocksCount: 0 };
  }

  const isCrlf = fullContent.includes("\r\n");
  const normalizedContent = fullContent.replace(/\r\n/g, "\n");
  const normalizedPatch = patchText.replace(/\r\n/g, "\n");

  const parsed = parseSearchReplaceBlocks(normalizedPatch);
  if (!parsed.success) {
    // Fallback to unified diff parser if SEARCH/REPLACE parsing failed but unified markers exist
    if (normalizedPatch.includes("@@ -") || normalizedPatch.includes("--- a/")) {
      const unifiedResult = applyUnifiedDiff(normalizedContent, normalizedPatch);
      if (unifiedResult) {
        return {
          success: true,
          code: isCrlf ? unifiedResult.replace(/\n/g, "\r\n") : unifiedResult,
          reason: null,
          blocksCount: 1,
        };
      }
      return { success: false, code: null, reason: "Malformed unified diff could not be applied.", blocksCount: 0 };
    }
    return { success: false, code: null, reason: parsed.reason, blocksCount: 0 };
  }

  const matches = [];
  for (let b = 0; b < parsed.blocks.length; b++) {
    const block = parsed.blocks[b];
    const matchResult = findMatchInContent(normalizedContent, block.search, block.replace);
    if (!matchResult.found) {
      return {
        success: false,
        code: null,
        reason: `Block ${b + 1}: ${matchResult.reason}`,
        blocksCount: parsed.blocks.length,
      };
    }

    matches.push({
      start: matchResult.start,
      end: matchResult.end,
      replace: matchResult.replace,
      blockNum: b + 1,
    });
  }

  // Check for overlapping matches
  matches.sort((a, b) => a.start - b.start);
  for (let i = 0; i < matches.length - 1; i++) {
    if (matches[i].end > matches[i + 1].start) {
      return {
        success: false,
        code: null,
        reason: `Overlapping blocks detected: Block ${matches[i].blockNum} and Block ${matches[i + 1].blockNum}.`,
        blocksCount: parsed.blocks.length,
      };
    }
  }

  // Apply atomically in reverse order (bottom to top)
  matches.sort((a, b) => b.start - a.start);
  let updated = normalizedContent;
  for (const m of matches) {
    updated = updated.slice(0, m.start) + m.replace + updated.slice(m.end);
  }

  const finalCode = isCrlf ? updated.replace(/\n/g, "\r\n") : updated;
  return {
    success: true,
    code: finalCode,
    reason: null,
    blocksCount: parsed.blocks.length,
  };
}

/**
 * Surgically apply SEARCH/REPLACE blocks or unified diff to file content.
 * Returns updated content string, or null on failure.
 *
 * @param {string} fullContent
 * @param {string} patchText
 * @returns {string|null}
 */
export function applySearchReplace(fullContent, patchText) {
  const result = applySearchReplaceDetailed(fullContent, patchText);
  return result.success ? result.code : null;
}

/**
 * Extract replace blocks from diff-style output.
 * @param {string} patchText
 * @returns {string[]}
 */
export function extractReplaceBlocks(patchText) {
  if (!patchText) return [];
  const parsed = parseSearchReplaceBlocks(patchText);
  if (parsed.success && parsed.blocks) {
    return parsed.blocks.map((b) => b.replace);
  }
  return [];
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
        max_tokens: 4096,
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
          max_tokens: 4096,
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

    const patchVal = validatePatchOutput(fixedCode, targetFile);
    if (!patchVal.valid) {
      this.logger.warn(`Single-shot patch validation rejected: ${patchVal.reason}`);
      return {
        success: false,
        rootCause: `Single-shot repair rejected by validation: ${patchVal.reason}`,
        modifiedFiles: [],
        testCommand,
        testOutput: patchVal.reason,
        iterations: 1,
      };
    }

    // 1. Snapshot original file before overwriting
    const originalContent = await this.tools.getRepoFile(targetFile);

    // 2. Overwrite target file with returned code
    await this.tools.applyFilePatch(targetFile, fixedCode);

    // 3. Run workspace test/build command once
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
      const diag = extractVerificationDiagnostics(failureOutput, testResult.exitCode);
      this.logger.warn(
        `❌ Single-shot remediation was unsuccessful (exit code: ${testResult.exitCode}).\nCommand: '${testCommand}'\n${diag.summary}\nRolling back unverified changes...`
      );
      if (originalContent && !originalContent.startsWith("Error:")) {
        await this.tools.applyFilePatch(targetFile, originalContent);
        this.logger.info(`↩️ Rolled back unverified fix on '${targetFile}'.`);
      }
      return {
        success: false,
        rootCause: `Single-shot remediation failed verification in \`${targetFile}\`:\n${diag.summary}`,
        modifiedFiles: [],
        fixedCode,
        testCommand,
        testOutput: failureOutput || `Failed with exit code ${testResult.exitCode}`,
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

    // -------------------------------------------------------------------------
    // Phase 1: Local Deterministic Repair (0 Tokens Consumed)
    // -------------------------------------------------------------------------
    const deterministicFixer = new DeterministicFixer({ tools: this.tools, logger: this.logger });
    const byFileMap = new Map();
    for (const culprit of culprits) {
      const errList = culprit.structuredErrors || (culprit.errors || []).map((e) => ({
        filePath: culprit.targetFile,
        lineNum: culprit.lineNum || 1,
        rule: String(e).match(/\b([a-zA-Z0-9_\-/@]+)$/)?.[1] || "",
        symbol: String(e).match(/'([a-zA-Z0-9_$]+)'|"([a-zA-Z0-9_$]+)"/)?.[1] || "",
        message: String(e),
        raw: String(e),
      }));
      byFileMap.set(culprit.targetFile, errList);
    }

    this.logger.info(`⚡ Attempting local deterministic auto-fixes across ${culprits.length} file(s)...`);
    const { repairedFiles, residualFiles, allFixes } = await deterministicFixer.runBatchDeterministicRepair(byFileMap);

    if (repairedFiles.length > 0) {
      modifiedFiles.push(...repairedFiles);
      rootCauses.push(...allFixes.map((f) => `- ${f}`));
      this.logger.info(`✅ Deterministically repaired ${repairedFiles.length} file(s) locally without LLM calls.`);
    }

    // Fast verification: did deterministic auto-fixes resolve all failures?
    let preCheckPassed = false;
    let preCheckErrorOutput = "";
    try {
      this.logger.info(`Executing fast verification check: '${testCommand}'...`);
      const preCheckJson = await this.tools.runSandboxTest(testCommand);
      const preCheck = JSON.parse(preCheckJson);
      if (preCheck.exitCode === 0 && modifiedFiles.length > 0) {
        preCheckPassed = true;
        this.logger.info(`🎉 All CI issues resolved deterministically in sandbox! Total LLM tokens used: 0.`);
        return {
          success: true,
          rootCause: `Automated deterministic remediation resolved errors across ${modifiedFiles.length} file(s) with 0 LLM tokens:\n${rootCauses.join("\n")}`,
          modifiedFiles,
          testCommand,
          testOutput: preCheck.stdout || "Verification passed cleanly with exit code 0.",
          iterations: 1,
        };
      }
      preCheckErrorOutput = (preCheck.stderr || preCheck.stdout || "").trim();
    } catch (err) {
      preCheckErrorOutput = err.message || "";
    }

    // -------------------------------------------------------------------------
    // Phase 2: Token-Budgeted LLM Pipeline for Residual Files
    // -------------------------------------------------------------------------
    // Re-diagnose fresh errors on the actual post-deterministic sandbox output!
    let targetsToFix = [];

    if (preCheckErrorOutput) {
      const freshDiag = diagnoseLogErrors(preCheckErrorOutput, this.tools.repo || "");
      if (freshDiag.byFile && freshDiag.byFile.size > 0) {
        this.logger.info(
          `🔄 Re-diagnosed sandbox failure: ${freshDiag.errors.length} residual error(s) across ${freshDiag.byFile.size} file(s).`
        );
        targetsToFix = Array.from(freshDiag.byFile.entries()).map(([targetFile, errs]) => ({
          targetFile,
          lineNum: errs[0].lineNum || 1,
          errors: errs.map((e) => e.message || e.raw),
          structuredErrors: errs,
        }));
      }
    }

    // Fallback if re-diagnosis produced no structured errors: use culprits filtered by residualFiles or error text
    if (targetsToFix.length === 0) {
      targetsToFix = culprits.filter((c) => {
        if (residualFiles.includes(c.targetFile)) return true;
        if (preCheckErrorOutput) {
          const baseName = c.targetFile.split("/").pop();
          if (preCheckErrorOutput.includes(c.targetFile) || preCheckErrorOutput.includes(baseName)) {
            return true;
          }
        }
        return false;
      });
    }

    const maxFiles = Math.min(targetsToFix.length, 15);
    const snapshots = new Map();
    const phase2PatchedFiles = [];

    if (maxFiles > 0) {
      this.logger.info(`🤖 Dispatching LLM remediation on ${maxFiles} residual file(s) (1 file/turn, max 3k in / 1k out)...`);
    }

    for (let i = 0; i < maxFiles; i++) {
      const culprit = targetsToFix[i];
      const targetFile = culprit.targetFile;
      const errorText = Array.isArray(culprit.errors) && culprit.errors.length > 0
        ? culprit.errors.slice(0, 3).join("\n")
        : `CI failure at line ${culprit.lineNum}`;

      try {
        const fullContent = await this.tools.getRepoFile(targetFile);
        if (!fullContent || fullContent.startsWith("Error:")) {
          this.logger.warn(`Could not read '${targetFile}'. Skipping.`);
          continue;
        }

        // Snapshot original content before any candidate edits for atomic rollback
        if (!snapshots.has(targetFile)) {
          snapshots.set(targetFile, fullContent);
        }

        const linesCount = fullContent.split("\n").length;
        // Never pass full files in multi-file remediation unless tiny (<= 25 lines)
        const isFullFile = linesCount <= 25;
        let targetSnippet = "";
        let enclosingScope = "";
        let topImports = "";

        if (isFullFile) {
          targetSnippet = fullContent;
        } else {
          const ctx = extractCodeContext(fullContent, culprit.lineNum || 1, 8);
          targetSnippet = ctx.targetSnippet;
          enclosingScope = ctx.enclosingScope;
          topImports = ctx.topImports;
        }

        // Clamp snippet to stay strictly under input budget (~1500 tokens / 4,500 chars)
        if (targetSnippet.length > 4500) {
          targetSnippet = targetSnippet.slice(0, 4500);
        }

        this.logger.info(`[${i + 1}/${maxFiles}] [Groq (${this.model})] Patching '${targetFile}' (${culprit.errors?.length || 1} error(s))...`);

        const prompt = buildRemediationUserPrompt({
          filePath: targetFile,
          errorMessage: errorText,
          lineWindowSnippet: targetSnippet,
          enclosingScope,
          topImports,
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
              max_tokens: 1024,
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
              const backoff = Math.min(attempts * 4000, 15000);
              this.logger.warn(
                `[Groq] Rate-limit/timeout on '${targetFile}' (${groqErr.message}). Retrying in ${backoff / 1000}s (attempt ${attempts}/${maxAttempts})...`
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
        const finishReason = completion?.choices?.[0]?.finish_reason || "unknown";
        const promptTokens = completion?.usage?.prompt_tokens ?? -1;
        const completionTokens = completion?.usage?.completion_tokens ?? -1;
        const totalTokens = completion?.usage?.total_tokens ?? -1;
        const cleaned = cleanRawCodeOutput(rawOutput);

        let detectedFormat = "UNKNOWN";
        let blocksCount = 0;
        if (cleaned.includes("<<<<<<< SEARCH")) {
          detectedFormat = "SEARCH_REPLACE";
          blocksCount = (cleaned.match(/<<<<<<< SEARCH/g) || []).length;
        } else if (cleaned.includes("@@ -") || cleaned.includes("--- a/")) {
          detectedFormat = "UNIFIED_DIFF";
          blocksCount = (cleaned.match(/@@ -\d+/g) || []).length;
        } else if (isFullFile) {
          detectedFormat = "FULL_FILE";
          blocksCount = 1;
        }

        const isTruncated = isTruncatedCode(rawOutput) || finishReason === "length";

        // Requirement 3: Capture sanitized diagnostic information (no secrets or sensitive source code)
        this.logger.info(
          `[Groq Diagnostic] Target: '${targetFile}' | Format: ${detectedFormat} | Finish: ${finishReason} | Tokens: ${promptTokens} in / ${completionTokens} out / ${totalTokens} total | Truncated: ${isTruncated} | Blocks: ${blocksCount}`
        );

        // Strong AI Output Validation
        const patchValidation = validatePatchOutput(cleaned, targetFile);
        if (!patchValidation.valid) {
          this.logger.warn(`[Validation Rejected] Patch for '${targetFile}': ${patchValidation.reason}`);
          continue;
        }

        let finalCode = "";
        const patchResult = applySearchReplaceDetailed(fullContent, cleaned);
        if (patchResult.success) {
          finalCode = patchResult.code;
        } else if (isFullFile && cleaned.length >= fullContent.length * 0.7) {
          finalCode = cleaned;
        } else {
          this.logger.warn(
            `Could not safely match diff markers for '${targetFile}': ${patchResult.reason || "unknown matching failure"}. Skipping to prevent corruption.`
          );
          continue;
        }

        // Strong AI Output Validation on Modified File (AST Syntax Parsing)
        const fileValidation = validateModifiedFile(fullContent, finalCode, targetFile);
        if (!fileValidation.valid) {
          this.logger.warn(`[Validation Rejected] Modified '${targetFile}': ${fileValidation.reason}`);
          continue;
        }

        await this.tools.applyFilePatch(targetFile, finalCode);
        if (!phase2PatchedFiles.includes(targetFile)) {
          phase2PatchedFiles.push(targetFile);
        }
        if (!modifiedFiles.includes(targetFile)) {
          modifiedFiles.push(targetFile);
        }
        rootCauses.push(`- \`${targetFile}\`: resolved ${culprit.errors?.length || 1} error(s) via LLM`);

        // Rate-limit safety pause before next file (default 2s)
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
      const diag = extractVerificationDiagnostics(failureOutput, testResult.exitCode);
      this.logger.error(
        `❌ Multi-file remediation failed verification (exit code: ${testResult.exitCode}).\nCommand: '${testCommand}'\n${diag.summary}\nFull verification output:\n${failureOutput}`
      );

      // Atomic Rollback: Revert all files modified in Phase 2 so sandbox is not left corrupted
      for (const [revertPath, originalCode] of snapshots.entries()) {
        try {
          await this.tools.applyFilePatch(revertPath, originalCode);
          this.logger.info(`↩️ Rolled back candidate changes to '${revertPath}'.`);
        } catch (rbErr) {
          this.logger.error(`Failed to rollback '${revertPath}': ${rbErr.message}`);
        }
      }

      return {
        success: false,
        rootCause: `Remediation failed verification across ${modifiedFiles.length} file(s). Rolled back candidate edits.`,
        modifiedFiles: repairedFiles,
        testCommand,
        testOutput: failureOutput,
        iterations: 1,
      };
    }
  }
}

