/**
 * Log processing service: strips ANSI escape sequences and extracts deterministic failure locations.
 */

import stripAnsi from "strip-ansi";
import AdmZip from "adm-zip";

export const CULPRIT_REGEX = /(?:[\w.-]+\/)*[\w.-]+\.(?:jsx?|tsx?|json|py):(\d+)/i;

/**
 * Extract text from either a raw text string, an ArrayBuffer/Buffer (zip or text).
 * @param {string | Buffer | ArrayBuffer} rawLogBuffer
 * @returns {string}
 */
export function extractRawLogText(rawLogBuffer) {
  if (!rawLogBuffer) return "";
  if (typeof rawLogBuffer === "string") return rawLogBuffer;

  const buffer = Buffer.isBuffer(rawLogBuffer)
    ? rawLogBuffer
    : Buffer.from(rawLogBuffer);

  // Check if buffer is a ZIP file (starts with PK\x03\x04)
  if (buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b) {
    try {
      const zip = new AdmZip(buffer);
      const zipEntries = zip.getEntries();
      const textParts = [];

      for (const entry of zipEntries) {
        if (!entry.isDirectory && (entry.entryName.endsWith(".txt") || entry.entryName.endsWith(".log"))) {
          const content = zip.readAsText(entry);
          textParts.push(`=== Log: ${entry.entryName} ===\n${content}`);
        }
      }
      return textParts.join("\n\n");
    } catch {
      return buffer.toString("utf-8");
    }
  }

  return buffer.toString("utf-8");
}

/**
 * Strips GitHub Actions ISO timestamps and workflow annotations (##[error], etc.).
 * @param {string} raw
 * @returns {string}
 */
export function cleanGHActionsLog(raw) {
  if (!raw) return "";
  return raw
    .replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\s+/gm, "")
    .replace(/##\[(?:error|warning|debug|notice)\]\s*/gm, "");
}

/**
 * Extract only the fatal error line matching FAIL, error:, or Error:
 * @param {string} logText
 * @returns {string}
 */
export function extractFatalErrorLine(logText, targetFile = "") {
  if (!logText) return "";
  const cleaned = cleanGHActionsLog(stripAnsi(typeof logText === "string" ? logText : String(logText)));
  const lines = cleaned.split("\n").map((l) => l.trim()).filter(Boolean);

  // If a target file is known, collect up to 3 error lines under that specific file
  if (targetFile) {
    const baseName = targetFile.split("/").pop();
    const fileErrors = [];
    let inFileBlock = false;

    for (const l of lines) {
      if (l.includes(baseName)) {
        inFileBlock = true;
        continue;
      }
      if (inFileBlock) {
        if (l.startsWith("/") || (l.includes("/") && !l.includes("error") && !l.includes("warning"))) {
          break; // Entered next file block
        }
        if (/\berror\b/i.test(l) && !/Process completed with exit code/i.test(l)) {
          fileErrors.push(l);
        }
      }
    }

    if (fileErrors.length > 0) {
      return fileErrors.slice(0, 3).join("\n");
    }
  }

  const fatalLine = lines.find((l) => {
    if (/Process completed with exit code/i.test(l)) return false;
    if (/^===.*===$/.test(l)) return false;
    return (
      /\bFAIL\b/i.test(l) ||
      /\berror\b/i.test(l) ||
      /\bError\b/.test(l) ||
      /\b(?:SyntaxError|TypeError|ReferenceError)\b/i.test(l)
    );
  });
  return fatalLine || lines[0] || "CI Build / Test Failure";
}

/**
 * Sanitize file paths extracted from GitHub Actions runners or container logs.
 * Strips /home/runner/work/:repo/:repo, D:/a/:repo/:repo, /workspace/, and duplicate repo folders.
 * @param {string} rawPath
 * @param {string} [repoName=""]
 * @returns {string} Clean relative file path from repository root
 */
export function cleanRepoFilePath(rawPath, repoName = "") {
  if (!rawPath) return "";
  let clean = rawPath.replace(/\\/g, "/");
  clean = clean.replace(/^.*\/work\/[^/]+\/[^/]+\//i, "");
  clean = clean.replace(/^[a-zA-Z]:\/a\/[^/]+\/[^/]+\//i, "");
  clean = clean.replace(/^.*(?:workspace)\//i, "");
  clean = clean.replace(/^([a-zA-Z0-9_\-]+)\/\1\//i, "");
  if (repoName) {
    const repoPrefix = new RegExp("^" + repoName + "/", "i");
    clean = clean.replace(repoPrefix, "");
  }
  return clean.replace(/^\/+/, "");
}

/**
 * Extract culprit file location and line number using stack trace regex:
 * /(?:[\w.-]+\/)*[\w.-]+\.(?:jsx?|tsx?|json|py):(\d+)/i
 *
 * @param {string} logText
 * @returns {{ targetFile: string, lineNum: number } | null}
 */
export function extractCulpritLocation(logText) {
  if (!logText) return null;
  const rawText = extractRawLogText(logText);
  const cleaned = cleanGHActionsLog(stripAnsi(rawText));
  const normalized = cleaned.replace(/\\/g, "/");

  const match = normalized.match(CULPRIT_REGEX);
  if (match) {
    const rawPath = match[0].slice(0, match[0].lastIndexOf(":"));
    const targetFile = cleanRepoFilePath(rawPath);
    const lineNum = parseInt(match[1], 10);
    return { targetFile, lineNum };
  }

  // Fallback for ESLint / Linter multi-line format:
  // /path/to/file.ext
  // [Error:]   10:15  error  'foo' is defined but never used
  const lines = normalized.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const fileMatch = line.match(/(?:[\w.-]+\/)*[\w.-]+\.(?:jsx?|tsx?|json|py)/i);
    if (fileMatch && !line.includes(" error ") && !line.includes(" warning ")) {
      const relPath = cleanRepoFilePath(fileMatch[0]);
      for (let j = 1; j <= 10 && i + j < lines.length; j++) {
        const subLine = lines[i + j];
        if (!subLine || (!subLine.includes("error") && !subLine.includes("warning") && subLine.includes("/"))) {
          break;
        }
        const lineCol = subLine.match(/(?:(?:Error|Warning|##\[\w+\]):\s*)?(\d+):(\d+)/i);
        if (lineCol) {
          return { targetFile: relPath, lineNum: parseInt(lineCol[1], 10) };
        }
      }
    }
  }

  return null;
}

/**
 * Extract all culprit files and their associated error lines from build logs.
 * Supports stack traces, Jest, ESLint table formats, TypeScript, and Python logs.
 *
 * @param {string} logText
 * @param {string} [repoName=""]
 * @returns {Array<{ targetFile: string, lineNum: number, errors: string[] }>}
 */
export function extractAllCulprits(logText, repoName = "") {
  if (!logText) return [];
  const rawText = extractRawLogText(logText);
  const cleaned = cleanGHActionsLog(stripAnsi(rawText));
  const normalized = cleaned.replace(/\\/g, "/");
  const lines = normalized.split("\n");
  const culpritsMap = new Map();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // 1. Single-line stack trace or compiler format: path/to/file.ext:10:15
    const singleMatch = line.match(/(?:[\w.-]+\/)*[\w.-]+\.(?:jsx?|tsx?|json|py):(\d+)/i);
    if (singleMatch && (/\berror\b/i.test(line) || /\bFAIL\b/i.test(line))) {
      const rawPath = singleMatch[0].slice(0, singleMatch[0].lastIndexOf(":"));
      const targetFile = cleanRepoFilePath(rawPath, repoName);
      const lineNum = parseInt(singleMatch[1], 10);
      if (!culpritsMap.has(targetFile)) {
        culpritsMap.set(targetFile, { targetFile, lineNum, errors: [line] });
      } else {
        culpritsMap.get(targetFile).errors.push(line);
      }
      continue;
    }

    // 2. Multi-line ESLint / Linter table format
    const fileMatch = line.match(/(?:[\w.-]+\/)*[\w.-]+\.(?:jsx?|tsx?|json|py)/i);
    if (fileMatch && !line.includes(" error ") && !line.includes(" warning ")) {
      const targetFile = cleanRepoFilePath(fileMatch[0], repoName);
      let firstLineNum = null;
      const errors = [];

      for (let j = 1; j <= 25 && i + j < lines.length; j++) {
        const subLine = lines[i + j].trim();
        // End of file error block if next file header or empty
        if (!subLine || (!subLine.includes("error") && !subLine.includes("warning") && subLine.includes("/"))) {
          break;
        }
        if (/\berror\b/i.test(subLine) && !/Process completed with exit code/i.test(subLine)) {
          errors.push(subLine);
          if (firstLineNum === null) {
            const lineCol = subLine.match(/(?:(?:Error|Warning|##\[\w+\]):\s*)?(\d+):(\d+)/i);
            if (lineCol) firstLineNum = parseInt(lineCol[1], 10);
          }
        }
      }

      if (errors.length > 0) {
        if (!culpritsMap.has(targetFile)) {
          culpritsMap.set(targetFile, { targetFile, lineNum: firstLineNum || 1, errors });
        } else {
          culpritsMap.get(targetFile).errors.push(...errors);
        }
      }
    }
  }

  // Fallback if no multi-line culprits were detected
  if (culpritsMap.size === 0) {
    const single = extractCulpritLocation(logText);
    if (single) {
      const fatal = extractFatalErrorLine(logText, single.targetFile);
      culpritsMap.set(single.targetFile, {
        targetFile: single.targetFile,
        lineNum: single.lineNum,
        errors: [fatal],
      });
    }
  }

  return Array.from(culpritsMap.values());
}


/**
 * Return only a targeted 30-line window centered around lineNum
 * (15 lines before to 15 lines after) with line numbers prepended.
 *
 * @param {string} fileContent - Entire file text
 * @param {number} lineNum - Offending line number (1-indexed)
 * @param {number} [windowSize=15] - Lines before and after (default 15 = 30 lines total)
 * @returns {string} Numbered line window snippet (e.g., '14: import toast from ...')
 */
export function getLineWindow(fileContent, lineNum, windowSize = 15) {
  if (!fileContent || typeof fileContent !== "string") return "";
  const lines = fileContent.split("\n");
  const num = parseInt(lineNum, 10);
  if (!num || isNaN(num)) {
    return lines.slice(0, windowSize * 2).map((l, idx) => `${idx + 1}: ${l}`).join("\n");
  }
  const start = Math.max(1, num - windowSize);
  const end = Math.min(lines.length, num + windowSize);
  return lines.slice(start - 1, end).map((l, idx) => `${start + idx}: ${l}`).join("\n");
}

/**
 * Backwards-compatible log parsing helper.
 * @param {string | Buffer} rawLog
 * @param {number} [maxLines=30]
 */
export function parseLog(rawLog, maxLines = 30) {
  const rawText = extractRawLogText(rawLog);
  const unstripped = stripAnsi(rawText).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const cleanLog = cleanGHActionsLog(unstripped);
  const lines = cleanLog.split("\n").map((l) => l.trimEnd()).filter(Boolean);
  const culprit = extractCulpritLocation(cleanLog);
  const fatalErrorLine = extractFatalErrorLine(cleanLog);

  let extractedWindow = lines.slice(-maxLines).join("\n");
  const fatalIndex = lines.findIndex((l) => /\bFAIL\b/i.test(l) || /\berror:/i.test(l) || /\bError:/.test(l));
  if (fatalIndex !== -1) {
    const start = Math.max(0, fatalIndex - 5);
    const end = Math.min(lines.length, start + maxLines);
    extractedWindow = lines.slice(start, end).join("\n");
  }

  return {
    cleanLog,
    extractedWindow,
    totalLines: lines.length,
    culprit,
    fatalErrorLine,
    detectedTargets: culprit ? [{ file: culprit.targetFile, line: culprit.lineNum }] : [],
  };
}
