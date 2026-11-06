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
 * Verify balanced braces and parentheses.
 * @param {string} code
 * @returns {boolean}
 */
export function hasBalancedBrackets(code) {
  if (!code) return true;
  // Strip comments and string literals to prevent false positives in strings
  const sanitized = code
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/'(?:\\.|[^\\'])*'/g, "''")
    .replace(/"(?:\\.|[^\\"])*"/g, '""')
    .replace(/`(?:\\.|[^\\`])*`/g, "``");

  const stack = [];
  const pairs = { "}": "{", ")": "(", "]": "[" };

  for (let i = 0; i < sanitized.length; i++) {
    const char = sanitized[i];
    if (char === "{" || char === "(" || char === "[") {
      stack.push(char);
    } else if (char === "}" || char === ")" || char === "]") {
      if (stack.length === 0 || stack.pop() !== pairs[char]) {
        return false;
      }
    }
  }

  return stack.length === 0;
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

  // 5. JSON files must parse cleanly
  if (filePath.endsWith(".json")) {
    try {
      JSON.parse(newContent);
    } catch (jsonErr) {
      return { valid: false, reason: `JSON syntax error: ${jsonErr.message}` };
    }
  }

  // 6. JS/JSX/TS/TSX bracket balance check
  if (/\.(?:jsx?|tsx?)$/i.test(filePath)) {
    if (!hasBalancedBrackets(newContent)) {
      return { valid: false, reason: "Unbalanced brackets or parentheses in modified code." };
    }
  }

  return { valid: true };
}
