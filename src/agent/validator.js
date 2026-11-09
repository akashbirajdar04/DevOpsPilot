import { parse } from "@babel/parser";

/**
 * AI Output Validation Engine.
 * Verifies generated patches and code before applying to sandbox workspace.
 * Guards against syntax errors, truncation placeholders, conflict markers, and destructive modifications.
 */

/**
 * Check if code contains omission placeholders or truncation comments.
 * @param {string} code
 * @returns {boolean}
 */
export function hasTruncationMarkers(code) {
  if (!code || typeof code !== "string") return false;
  return /(\/\/|\/\*)\s*(\[?.*(?:remaining lines|rest of code|code omitted|token limits|code continues))/i.test(code);
}

/**
 * Check for uninitialized constants in JS/TS code: `const foo;` or `const foo\n`
 * @param {string} code
 * @returns {boolean}
 */
export function hasUninitializedConst(code) {
  if (!code) return false;
  // Match `const identifier;` or `const identifier` followed by newline and next statement (not `=`)
  return /\bconst\s+[a-zA-Z0-9_$]+(?:\s*;|\s*\r?\n\s*(?:[a-zA-Z0-9_$/]|\/\*))/m.test(code);
}

/**
 * Validate JavaScript / JSX / TypeScript syntax using AST parser.
 * Replaces naive bracket counting to accurately handle JSX tags, strings,
 * comments, regex literals, template literals, and optional catch binding.
 *
 * @param {string} code
 * @param {string} [filePath=""]
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validateCodeSyntax(code, filePath = "") {
  if (!code || typeof code !== "string") {
    return { valid: false, reason: "Code is empty or invalid." };
  }

  // JSON files
  if (filePath.endsWith(".json")) {
    try {
      JSON.parse(code);
      return { valid: true };
    } catch (jsonErr) {
      return { valid: false, reason: `JSON syntax error: ${jsonErr.message}` };
    }
  }

  // JS, JSX, TS, TSX files
  if (/\.(?:jsx?|tsx?|mjs|cjs)$/i.test(filePath) || !filePath) {
    try {
      parse(code, {
        sourceType: "module",
        plugins: ["jsx", "typescript"],
        errorRecovery: false,
      });
      return { valid: true };
    } catch (parseErr) {
      return {
        valid: false,
        reason: `Syntax error in '${filePath}': ${parseErr.message}`,
      };
    }
  }

  return { valid: true };
}

/**
 * Verify balanced braces and parentheses using AST parser with fallback.
 * @param {string} code
 * @param {string} [filePath=""]
 * @returns {boolean}
 */
export function hasBalancedBrackets(code, filePath = "") {
  if (!code) return true;
  const result = validateCodeSyntax(code, filePath);
  return result.valid;
}

/**
 * Validate LLM patch output before applying.
 *
 * @param {string} patchText - Raw output from LLM
 * @param {string} targetFile - File being repaired
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validatePatchOutput(patchText, targetFile = "") {
  if (!patchText || !patchText.trim()) {
    return { valid: false, reason: "Empty patch received from LLM." };
  }

  // 1. Check for truncation comments
  if (hasTruncationMarkers(patchText)) {
    return { valid: false, reason: "Patch contains truncation markers or omitted code comments." };
  }

  // 2. Check for raw Git conflict markers (not part of SEARCH/REPLACE structure)
  if (patchText.includes("<<<<<<< HEAD") || patchText.includes(">>>>>>> origin")) {
    return { valid: false, reason: "Patch contains raw Git merge conflict markers." };
  }

  // 3. Check for unclosed markdown code fences
  const fenceCount = (patchText.match(/^```/gm) || []).length;
  if (fenceCount % 2 !== 0) {
    return { valid: false, reason: "Patch contains an unclosed markdown code fence." };
  }

  // 4. Check for uninitialized constants
  if (hasUninitializedConst(patchText)) {
    return { valid: false, reason: "Patch contains uninitialized 'const' declaration." };
  }

  return { valid: true };
}

/**
 * Validate syntax and integrity of updated file content before writing to disk.
 *
 * @param {string} originalContent
 * @param {string} newContent
 * @param {string} filePath
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validateModifiedFile(originalContent, newContent, filePath = "") {
  if (!newContent || !newContent.trim()) {
    return { valid: false, reason: "Updated content is empty." };
  }

  // 1. Must not contain residual conflict markers
  if (newContent.includes("<<<<<<< SEARCH") || newContent.includes(">>>>>>> REPLACE") || newContent.includes("=======")) {
    return { valid: false, reason: "Updated file contains unparsed diff markers." };
  }

  // 2. Must not contain truncation comments
  if (hasTruncationMarkers(newContent)) {
    return { valid: false, reason: "Updated file contains truncation or placeholder comments." };
  }

  // 3. Must not have lost more than 60% of original content (destructive rewrite)
  if (originalContent && originalContent.length > 200 && newContent.length < originalContent.length * 0.4) {
    return { valid: false, reason: "Destructive rewrite: updated file shrank by more than 60%." };
  }

  // 4. Check for uninitialized constants
  if (hasUninitializedConst(newContent)) {
    return { valid: false, reason: "Updated file contains uninitialized 'const' declaration." };
  }

  // 5. Structural & syntax validation using AST parser (JS, JSX, TS, TSX, JSON)
  const syntaxCheck = validateCodeSyntax(newContent, filePath);
  if (!syntaxCheck.valid) {
    return syntaxCheck;
  }

  return { valid: true };
}

