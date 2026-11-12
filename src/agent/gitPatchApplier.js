import { execa } from "execa";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { validateModifiedFile } from "./validator.js";

/**
 * Protected file patterns that automated remediation must never modify.
 */
export const PROTECTED_FILE_PATTERNS = [
  /^\.github\/workflows\//i,
  /^\.env(?:\..+)?$/i,
  /(?:^|\/)\.env(?:\..+)?$/i,
  /(?:^|\/)package-lock\.json$/i,
  /(?:^|\/)yarn\.lock$/i,
  /(?:^|\/)pnpm-lock\.yaml$/i,
  /(?:^|\/)bun\.lockb$/i,
  /^\.git\//i,
  /^\.npmrc$/i,
  /^\.ssh\//i,
];

/**
 * Checks if a given file path targets a protected file or directory.
 * @param {string} filePath
 * @returns {boolean}
 */
export function isProtectedFile(filePath) {
  if (!filePath || typeof filePath !== "string") return true;
  const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  return PROTECTED_FILE_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * Formats a patch so it contains valid git unified diff headers for `git apply`.
 * Discards conversational preamble and markdown fences, recalculates hunk line counts
 * mathematically, ensures context lines have valid leading spaces, and guarantees
 * canonical diff headers `--- a/...` and `+++ b/...`.
 *
 * @param {string} patchText
 * @param {string} targetFile
 * @returns {string}
 */
export function normalizeGitPatch(patchText, targetFile) {
  if (!patchText || typeof patchText !== "string") return "";
  let text = patchText.replace(/\r\n/g, "\n").trim();
  const cleanPath = targetFile ? targetFile.replace(/\\/g, "/").replace(/^\.\//, "") : "";

  // 1. If wrapped in markdown code fence (```diff ... ``` or ```patch ... ``` or ``` ... ```), extract fenced content
  const codeBlockMatch = text.match(/```(?:diff|patch)?\s*\n([\s\S]*?)\n```/i);
  if (codeBlockMatch) {
    text = codeBlockMatch[1].trim();
  } else {
    text = text.replace(/^```[a-zA-Z0-9_-]*\s*\n/m, "");
    text = text.replace(/\n```\s*$/m, "");
  }

  // 2. Discard conversational preamble before first diff marker or hunk header
  const firstMarkerIdx = text.search(/^(?:diff --git|--- |\+\+\+ |@@ )/m);
  if (firstMarkerIdx > 0) {
    text = text.substring(firstMarkerIdx).trim();
  }

  // 3. Parse lines and re-assemble hunks with correct line counts and leading spaces
  const lines = text.split("\n");
  const hunks = [];
  let currentHunk = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^@@\s*-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s*@@(.*)$/);
    if (match) {
      if (currentHunk) hunks.push(currentHunk);
      currentHunk = {
        oldStart: parseInt(match[1], 10),
        newStart: parseInt(match[2], 10),
        trailing: match[3] || "",
        lines: [],
      };
      continue;
    }

    if (!currentHunk) {
      continue;
    }

    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      break;
    }

    if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ") || line.startsWith("\\")) {
      currentHunk.lines.push(line);
    } else if (line === "") {
      currentHunk.lines.push(" ");
    } else {
      currentHunk.lines.push(" " + line);
    }
  }

  if (currentHunk) hunks.push(currentHunk);

  if (hunks.length === 0) {
    if (text.startsWith("--- ") || text.startsWith("diff --git")) {
      return text + "\n";
    }
    return cleanPath ? `--- a/${cleanPath}\n+++ b/${cleanPath}\n${text}\n` : text + "\n";
  }

  const out = cleanPath ? [`--- a/${cleanPath}`, `+++ b/${cleanPath}`] : [];
  for (const h of hunks) {
    let oldCount = 0;
    let newCount = 0;
    for (const l of h.lines) {
      if (l.startsWith("-")) {
        oldCount++;
      } else if (l.startsWith("+")) {
        newCount++;
      } else if (l.startsWith(" ")) {
        oldCount++;
        newCount++;
      }
    }
    out.push(`@@ -${h.oldStart},${oldCount} +${h.newStart},${newCount} @@${h.trailing}`);
    out.push(...h.lines);
  }

  return out.join("\n") + "\n";
}

/**
 * Surgically apply unified diff hunks (@@ -start,len +start,len @@) to file content.
 * Features a multi-strategy matching engine:
 * 1. Exact searchLines match
 * 2. Fuzzy whitespace-trimmed match
 * 3. Blank-tolerant match (handles source code blank lines omitted by LLM context)
 * 4. Focused deleted-lines match (when deleted lines are unique in the file)
 *
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
    const rawLines = hunkBody.split("\n");
    if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") {
      rawLines.pop();
    }

    const searchLines = [];
    const replaceLines = [];
    const deletedLines = [];
    const addedLines = [];

    for (const line of rawLines) {
      if (line.startsWith("\\")) {
        continue;
      } else if (line.startsWith("-")) {
        const text = line.slice(1);
        searchLines.push(text);
        deletedLines.push(text);
      } else if (line.startsWith("+")) {
        const text = line.slice(1);
        replaceLines.push(text);
        addedLines.push(text);
      } else if (line.startsWith(" ")) {
        const text = line.slice(1);
        searchLines.push(text);
        replaceLines.push(text);
      } else if (line === "") {
        searchLines.push("");
        replaceLines.push("");
      } else {
        searchLines.push(line);
        replaceLines.push(line);
      }
    }

    if (searchLines.length === 0) continue;

    const searchStr = searchLines.join("\n");
    const replaceStr = replaceLines.join("\n");

    // Strategy 1: Exact searchLines match
    if (updated.includes(searchStr)) {
      updated = updated.replace(searchStr, replaceStr);
      matches++;
      continue;
    }

    // Strategy 2: Fuzzy whitespace-trimmed match
    const contentLines = updated.split("\n");
    let foundIdx = -1;
    let matchedLength = -1;

    for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
      const slice = contentLines.slice(i, i + searchLines.length).map((l) => l.trim());
      if (slice.every((line, idx) => line === searchLines[idx].trim())) {
        foundIdx = i;
        matchedLength = searchLines.length;
        break;
      }
    }

    if (foundIdx !== -1) {
      contentLines.splice(foundIdx, matchedLength, replaceStr);
      updated = contentLines.join("\n");
      matches++;
      continue;
    }

    // Strategy 3: Blank-tolerant match (matching all non-empty search lines in order)
    const nonBlankSearch = searchLines.filter((l) => l.trim() !== "");
    if (nonBlankSearch.length >= 2) {
      let bStart = -1;
      let bEnd = -1;
      for (let i = 0; i < contentLines.length; i++) {
        if (contentLines[i].trim() === nonBlankSearch[0].trim()) {
          let sIdx = 0;
          let k = i;
          while (k < contentLines.length && sIdx < nonBlankSearch.length) {
            if (contentLines[k].trim() === "") {
              k++;
              continue;
            }
            if (contentLines[k].trim() === nonBlankSearch[sIdx].trim()) {
              sIdx++;
              k++;
            } else {
              break;
            }
          }
          if (sIdx === nonBlankSearch.length) {
            bStart = i;
            bEnd = k;
            break;
          }
        }
      }

      if (bStart !== -1 && bEnd !== -1) {
        contentLines.splice(bStart, bEnd - bStart, replaceStr);
        updated = contentLines.join("\n");
        matches++;
        continue;
      }
    }

    // Strategy 4: Focused deleted-lines match (when deleted lines appear uniquely)
    if (deletedLines.length > 0) {
      const delStr = deletedLines.join("\n");
      const occurrences = updated.split(delStr).length - 1;
      if (occurrences === 1) {
        updated = updated.replace(delStr, addedLines.join("\n"));
        matches++;
        continue;
      }

      const nonBlankDeleted = deletedLines.map((l) => l.trim()).filter(Boolean);
      let dMatches = [];
      for (let i = 0; i <= contentLines.length - nonBlankDeleted.length; i++) {
        const slice = contentLines.slice(i, i + nonBlankDeleted.length).map((l) => l.trim());
        if (slice.every((l, idx) => l === nonBlankDeleted[idx])) {
          dMatches.push(i);
        }
      }
      if (dMatches.length === 1) {
        contentLines.splice(dMatches[0], nonBlankDeleted.length, addedLines.join("\n"));
        updated = contentLines.join("\n");
        matches++;
        continue;
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
export function findMatchInContent(content, rawSearch, rawReplace) {
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

export class GitPatchApplier {
  /**
   * @param {object} options
   * @param {string} options.workspaceDir - Path to local git repository
   * @param {number} [options.maxChangedLines=150] - Maximum allowable changed lines
   * @param {number} [options.maxPatchBytes=32000] - Maximum patch size in bytes
   * @param {object} [options.logger=console]
   */
  constructor({ workspaceDir, maxChangedLines = 150, maxPatchBytes = 32000, logger = console }) {
    this.workspaceDir = path.resolve(workspaceDir);
    this.maxChangedLines = maxChangedLines;
    this.maxPatchBytes = maxPatchBytes;
    this.logger = logger;
    this.originalCommitSha = null;
  }

  /**
   * Record the original commit SHA of the workspace before applying any patches.
   * @returns {Promise<string>}
   */
  async recordOriginalCommit() {
    try {
      // Discard any unintentional lockfile changes from environment/setup
      await execa("git", ["checkout", "--", "package-lock.json"], { cwd: this.workspaceDir }).catch(() => {});
      await execa("git", ["checkout", "--", "*/package-lock.json"], { cwd: this.workspaceDir, shell: true }).catch(() => {});
      await execa("git", ["checkout", "--", "*/*/package-lock.json"], { cwd: this.workspaceDir, shell: true }).catch(() => {});

      const { stdout } = await execa("git", ["rev-parse", "HEAD"], {
        cwd: this.workspaceDir,
      });
      this.originalCommitSha = stdout.trim();
      return this.originalCommitSha;
    } catch (err) {
      this.logger.warn(`Could not record git commit SHA: ${err.message}`);
      this.originalCommitSha = null;
      return null;
    }
  }

  /**
   * Validate safety rules on target file before touching git.
   * @param {string} targetFile
   * @param {string[]} allowedFiles
   * @returns {{ safe: boolean, reason?: string }}
   */
  checkTargetSafety(targetFile, allowedFiles = []) {
    const cleanTarget = targetFile.replace(/\\/g, "/").replace(/^\.\//, "");

    // 1. Protected file check
    if (isProtectedFile(cleanTarget)) {
      return { safe: false, reason: `Modification to protected file '${cleanTarget}' is strictly prohibited.` };
    }

    // 2. Allowlist check
    if (allowedFiles.length > 0) {
      const normalizedAllowed = allowedFiles.map((f) => f.replace(/\\/g, "/").replace(/^\.\//, ""));
      const isAllowed = normalizedAllowed.some(
        (allowed) => allowed === cleanTarget || allowed.endsWith(cleanTarget) || cleanTarget.endsWith(allowed)
      );
      if (!isAllowed) {
        return {
          safe: false,
          reason: `File '${cleanTarget}' is not in the allowlist of permitted files: [${normalizedAllowed.join(", ")}].`,
        };
      }
    }

    return { safe: true };
  }

  /**
   * Validate and apply a unified diff patch to the workspace using git apply.
   *
   * @param {object} params
   * @param {string} params.patchText - Unified diff content
   * @param {string} params.targetFile - Intended target file
   * @param {string[]} [params.allowedFiles=[]] - Whitelist of files allowed to be modified
   * @returns {Promise<{
   *   success: boolean,
   *   modifiedFiles: string[],
   *   diff?: string,
   *   changedLines?: number,
   *   reason?: string
   * }>}
   */
  async applyPatch({ patchText, targetFile, allowedFiles = [] }) {
    if (!patchText || !patchText.trim()) {
      return { success: false, modifiedFiles: [], reason: "Patch content is empty." };
    }

    if (Buffer.byteLength(patchText, "utf-8") > this.maxPatchBytes) {
      return {
        success: false,
        modifiedFiles: [],
        reason: `Patch size (${Buffer.byteLength(patchText, "utf-8")} bytes) exceeds limit of ${this.maxPatchBytes} bytes.`,
      };
    }

    // 1. Validate target safety
    const safety = this.checkTargetSafety(targetFile, allowedFiles);
    if (!safety.safe) {
      return { success: false, modifiedFiles: [], reason: safety.reason };
    }

    // Ensure we have original commit recorded
    if (!this.originalCommitSha) {
      await this.recordOriginalCommit();
    }

    const cleanTarget = targetFile.replace(/\\/g, "/").replace(/^\.\//, "");
    const targetAbsPath = path.resolve(this.workspaceDir, cleanTarget);
    let originalContent = "";
    try {
      originalContent = await fs.readFile(targetAbsPath, "utf-8");
    } catch {}

    let tempPatchFile = null;

    try {
      const isSearchReplace = patchText.includes("<<<<<<< SEARCH") && patchText.includes(">>>>>>> REPLACE");

      if (isSearchReplace) {
        if (!originalContent) {
          return {
            success: false,
            modifiedFiles: [],
            reason: `Target file '${cleanTarget}' could not be read for SEARCH/REPLACE application.`,
          };
        }

        const srResult = applySearchReplaceDetailed(originalContent, patchText);
        if (!srResult.success || !srResult.code) {
          return {
            success: false,
            modifiedFiles: [],
            reason: `SEARCH/REPLACE failed for '${cleanTarget}': ${srResult.reason || "unknown error"}`,
          };
        }

        const validation = validateModifiedFile(originalContent, srResult.code, cleanTarget);
        if (!validation.valid) {
          return {
            success: false,
            modifiedFiles: [],
            reason: `SEARCH/REPLACE produced invalid content for '${cleanTarget}': ${validation.reason}`,
          };
        }

        await fs.writeFile(targetAbsPath, srResult.code, "utf-8");
      } else {
        const fullPatch = normalizeGitPatch(patchText, cleanTarget);

        // Write normalized patch to a temporary file for git apply
        tempPatchFile = path.join(os.tmpdir(), `healops-patch-${Date.now()}-${Math.random().toString(36).slice(2)}.patch`);
        await fs.writeFile(tempPatchFile, fullPatch, "utf-8");

        let appliedViaGitCli = false;
        let gitCliError = null;

        // Tier 2: Resilient git apply check with --recount, --ignore-space-change, --ignore-whitespace, -C1
        try {
          await execa("git", ["apply", "--check", "--recount", "--ignore-space-change", "--ignore-whitespace", "-C1", tempPatchFile], {
            cwd: this.workspaceDir,
          });

          await execa("git", ["apply", "--recount", "--ignore-space-change", "--ignore-whitespace", "-C1", tempPatchFile], {
            cwd: this.workspaceDir,
          });
          appliedViaGitCli = true;
        } catch (cliErr) {
          gitCliError = (cliErr.stderr || cliErr.message || "").trim();
          this.logger.warn?.(`Git CLI patch application failed ('${gitCliError}'). Attempting semantic hunk fallback...`);
        }

        // Tier 3: Semantic hunk application fallback if Git CLI was unable to apply
        if (!appliedViaGitCli) {
          if (!originalContent) {
            return {
              success: false,
              modifiedFiles: [],
              reason: `Target file '${cleanTarget}' could not be read for semantic fallback.`,
            };
          }

          const modifiedContent = applyUnifiedDiff(originalContent, fullPatch);
          if (!modifiedContent) {
            return {
              success: false,
              modifiedFiles: [],
              reason: `Git patch validation failed ('${gitCliError || "corrupt patch"}') and semantic hunk fallback could not match source.`,
            };
          }

          // Validate modified content with AST & integrity validator before writing
          const validation = validateModifiedFile(originalContent, modifiedContent, cleanTarget);
          if (!validation.valid) {
            return {
              success: false,
              modifiedFiles: [],
              reason: `Semantic patch fallback produced invalid content for '${cleanTarget}': ${validation.reason}`,
            };
          }

          await fs.writeFile(targetAbsPath, modifiedContent, "utf-8");
        }
      }

      // Tier 4: Post-application Git status & safety audit
      // 1. Inspect modified files using git diff --name-only
      const { stdout: diffNameOnly } = await execa("git", ["diff", "--name-only"], {
        cwd: this.workspaceDir,
      });
      const modifiedFiles = diffNameOnly
        .split("\n")
        .map((f) => f.trim().replace(/\\/g, "/"))
        .filter(Boolean);

      if (modifiedFiles.length === 0) {
        await this.rollback();
        return {
          success: false,
          modifiedFiles: [],
          reason: "Patch produced no effective file changes.",
        };
      }

      // Verify no protected or unauthorized files were modified
      for (const mod of modifiedFiles) {
        if (isProtectedFile(mod)) {
          await this.rollback();
          return {
            success: false,
            modifiedFiles: [],
            reason: `Patch illegally modified protected file '${mod}'. Rolled back workspace.`,
          };
        }

        if (allowedFiles.length > 0) {
          const cleanAllowed = allowedFiles.map((f) => f.replace(/\\/g, "/").replace(/^\.\//, ""));
          const match = cleanAllowed.some((a) => a === mod || a.endsWith(mod) || mod.endsWith(a));
          if (!match) {
            await this.rollback();
            return {
              success: false,
              modifiedFiles: [],
              reason: `Patch modified unauthorized file '${mod}' not in allowlist. Rolled back workspace.`,
            };
          }
        }

        // Validate AST syntax & integrity on all modified files
        const modAbsPath = path.resolve(this.workspaceDir, mod);
        let modContent = "";
        try {
          modContent = await fs.readFile(modAbsPath, "utf-8");
        } catch {
          continue;
        }

        let origForMod = "";
        if (mod === cleanTarget) {
          origForMod = originalContent;
        } else if (this.originalCommitSha) {
          try {
            const { stdout } = await execa("git", ["show", `${this.originalCommitSha}:${mod}`], { cwd: this.workspaceDir });
            origForMod = stdout;
          } catch {}
        }

        const syntaxCheck = validateModifiedFile(origForMod, modContent, mod);
        if (!syntaxCheck.valid) {
          await this.rollback();
          return {
            success: false,
            modifiedFiles: [],
            reason: `Patch introduced invalid syntax into '${mod}': ${syntaxCheck.reason}`,
          };
        }
      }

      // 2. Inspect status for untracked / deleted files
      const { stdout: statusPorcelain } = await execa("git", ["status", "--porcelain"], {
        cwd: this.workspaceDir,
      });
      const statusLines = statusPorcelain.split("\n").map((l) => l.trim()).filter(Boolean);
      for (const line of statusLines) {
        if (line.startsWith("??")) {
          await this.rollback();
          return {
            success: false,
            modifiedFiles: [],
            reason: `Patch created unexpected untracked file '${line.slice(3)}'. Rolled back workspace.`,
          };
        }
        if (line.startsWith("D ") || line.startsWith(" D")) {
          await this.rollback();
          return {
            success: false,
            modifiedFiles: [],
            reason: `Patch unexpectedly deleted file '${line.slice(2).trim()}'. Rolled back workspace.`,
          };
        }
      }

      // 3. Check changed lines limit using git diff --numstat
      const { stdout: numstat } = await execa("git", ["diff", "--numstat"], {
        cwd: this.workspaceDir,
      });
      let totalChangedLines = 0;
      for (const line of numstat.split("\n").filter(Boolean)) {
        const parts = line.split(/\s+/);
        const added = parseInt(parts[0], 10) || 0;
        const deleted = parseInt(parts[1], 10) || 0;
        totalChangedLines += added + deleted;
      }

      if (totalChangedLines > this.maxChangedLines) {
        await this.rollback();
        return {
          success: false,
          modifiedFiles: [],
          reason: `Patch modified ${totalChangedLines} lines, exceeding the safety limit of ${this.maxChangedLines} lines. Rolled back workspace.`,
        };
      }

      // 4. Inspect final diff
      const { stdout: finalDiff } = await execa("git", ["diff"], {
        cwd: this.workspaceDir,
      });

      return {
        success: true,
        modifiedFiles,
        diff: finalDiff,
        changedLines: totalChangedLines,
      };
    } finally {
      if (tempPatchFile) {
        await fs.rm(tempPatchFile, { force: true }).catch(() => {});
      }
    }
  }

  /**
   * Reset workspace back to the original commit SHA, discarding all changes.
   */
  async rollback() {
    try {
      await execa("git", ["checkout", "--", "."], { cwd: this.workspaceDir });
      await execa("git", ["clean", "-fd"], { cwd: this.workspaceDir });
      if (this.originalCommitSha) {
        await execa("git", ["reset", "--hard", this.originalCommitSha], { cwd: this.workspaceDir });
      }
      this.logger.info?.(`↩️ Workspace successfully reset to clean state (SHA: ${this.originalCommitSha || "HEAD"}).`);
      return true;
    } catch (err) {
      this.logger.error?.(`Failed to rollback workspace: ${err.message}`);
      return false;
    }
  }
}
