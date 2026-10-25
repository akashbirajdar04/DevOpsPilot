/**
 * Log processing service: strips ANSI escape sequences and extracts targeted error windows.
 */

import stripAnsi from "strip-ansi";
import AdmZip from "adm-zip";

const ERROR_PATTERNS = [
  /\bFAIL\b/i,
  /\bFAILED\b/i,
  /\bError:\b/i,
  /\bAssertionError\b/i,
  /\bModuleNotFoundError\b/i,
  /\bTypeError\b/i,
  /\bSyntaxError\b/i,
  /\bCannot find module\b/i,
  /\bExit code [1-9]\d*/i,
  /\bProcess completed with exit code [1-9]\d*/i,
  /\bERR!\b/i,
  /\bBUILD FAILED\b/i,
];

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

      // Find files that are log files
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
 * Extract targeted error addresses (file, line, col, message) from log text.
 * @param {string} cleanLog
 * @returns {Array<{ file: string, line?: number, column?: number, message?: string }>}
 */
export function extractFailureTargets(cleanLog) {
  const lines = cleanLog.split("\n");
  const targets = [];
  for (let i = 0; i < lines.length; i++) {
    // 1. ESLint / compiler / typescript style: file path followed by line:col error
    const fileMatch = lines[i].match(/(?:[a-zA-Z0-9_\-\.]+[/\\])+[a-zA-Z0-9_\-\.]+\.(?:jsx?|tsx?|vue|py|go|rs|json|ya?ml)/);
    if (fileMatch) {
      let relPath = fileMatch[0].replace(/^.*[/\\]work[/\\][^/\\]+[/\\][^/\\]+[/\\]/, "");
      relPath = relPath.replace(/^[/\\]+/, "");
      const nextLine = lines[i + 1] || "";
      const lineCol = nextLine.match(/^\s*(\d+):(\d+)\s+(?:error|warning)?\s*(.*)$/);
      if (lineCol) {
        targets.push({
          file: relPath,
          line: parseInt(lineCol[1], 10),
          column: parseInt(lineCol[2], 10),
          message: lineCol[3].trim(),
        });
        continue;
      }
    }
    // 2. Jest / test runner: FAIL path/to/file
    const failMatch = lines[i].match(/\b(?:FAIL|FAILED)\s+([a-zA-Z0-9_\-\./\\]+\.[a-zA-Z0-9]+)/i);
    if (failMatch) {
      const nextFew = lines.slice(i + 1, i + 5).map((l) => l.trim()).filter(Boolean).join(" ");
      targets.push({ file: failMatch[1], message: nextFew });
    }
  }
  return targets;
}

/**
 * Parse raw log, strip ANSI escapes, and extract a targeted failure window.
 * @param {string | Buffer} rawLog
 * @param {number} [maxLines=45]
 * @returns {{ cleanLog: string, extractedWindow: string, totalLines: number, errorCount: number, detectedTargets: Array<{ file: string, line?: number, column?: number, message?: string }> }}
 */
export function parseLog(rawLog, maxLines = 45) {
  const rawText = extractRawLogText(rawLog);
  const cleanLog = stripAnsi(rawText).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = cleanLog.split("\n").map((l) => l.trimEnd()).filter(Boolean);
  const detectedTargets = extractFailureTargets(cleanLog);

  if (lines.length <= maxLines) {
    return {
      cleanLog,
      extractedWindow: lines.join("\n"),
      totalLines: lines.length,
      errorCount: lines.filter((l) => ERROR_PATTERNS.some((p) => p.test(l))).length,
      detectedTargets,
    };
  }

  // Find line indices where error patterns match
  const errorIndices = [];
  lines.forEach((line, idx) => {
    if (ERROR_PATTERNS.some((p) => p.test(line))) {
      errorIndices.push(idx);
    }
  });

  if (errorIndices.length === 0) {
    const window = lines.slice(-maxLines);
    return {
      cleanLog,
      extractedWindow: window.join("\n"),
      totalLines: lines.length,
      errorCount: 0,
      detectedTargets,
    };
  }

  // Center window around the last major failure
  const lastErrorIdx = errorIndices[errorIndices.length - 1];
  const beforeCount = Math.floor(maxLines * 0.4);
  const afterCount = maxLines - beforeCount;

  let startIdx = Math.max(0, lastErrorIdx - beforeCount);
  let endIdx = Math.min(lines.length, lastErrorIdx + afterCount);

  if (endIdx - startIdx < maxLines) {
    startIdx = Math.max(0, endIdx - maxLines);
  }

  const selectedLines = lines.slice(startIdx, endIdx);

  return {
    cleanLog,
    extractedWindow: selectedLines.join("\n"),
    totalLines: lines.length,
    errorCount: errorIndices.length,
    detectedTargets,
  };
}
