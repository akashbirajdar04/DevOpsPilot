import { z } from "zod";

/**
 * Strict Zod schema for Groq-generated code remediation proposals.
 */
export const RemediationResponseSchema = z.object({
  status: z.enum(["fix_proposed", "no_fix"]),
  file: z.string().min(1).max(300),
  fix_type: z.enum([
    "syntax_error",
    "import_error",
    "type_error",
    "linter_rule",
    "dependency_error",
    "logic_error",
    "other",
  ]),
  patch: z.string().max(32000),
  explanation: z.string().max(2000),
});

/**
 * Normalize raw LLM output by safely stripping enclosing markdown code fences.
 * Handles ```json ... ``` or ``` ... ``` wrappers while preserving raw JSON content.
 *
 * @param {string} raw
 * @returns {string}
 */
export function normalizeJsonFences(raw) {
  if (!raw || typeof raw !== "string") return "";
  let text = raw.trim();

  // Strip <think>...</think> tags if present
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

  // If wrapped in ```json ... ``` or ``` ... ```
  const jsonFenceMatch = text.match(/^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```\s*$/i);
  if (jsonFenceMatch) {
    return jsonFenceMatch[1].trim();
  }

  // Also handle leading ```json without trailing fence or vice-versa
  if (text.startsWith("```json") || text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/i, "");
  }
  if (text.endsWith("```")) {
    text = text.replace(/\s*```$/, "");
  }

  return text.trim();
}

/**
 * Validates that a string looks like a standard unified diff patch.
 * Must contain diff hunks (`@@ -... +... @@`) or file headers.
 *
 * @param {string} patch
 * @returns {boolean}
 */
export function isValidUnifiedDiff(patch) {
  if (!patch || typeof patch !== "string") return false;
  const trimmed = patch.trim();
  if (!trimmed) return false;

  // Must contain standard hunk header @@ -start,len +start,len @@
  const hasHunk = /@@\s*-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s*@@/.test(trimmed);
  // Or at least --- and +++ lines and diff changes
  const hasHeaders = trimmed.includes("--- ") && trimmed.includes("+++ ");
  // Or SEARCH/REPLACE markers
  const hasSearchReplace = trimmed.includes("<<<<<<< SEARCH") && trimmed.includes(">>>>>>> REPLACE");

  return hasHunk || hasHeaders || hasSearchReplace;
}

export const isValidPatchFormat = isValidUnifiedDiff;

/**
 * Safely parse and validate an AI remediation response according to strict schema rules.
 *
 * @param {string} rawResponse - Raw string output from Groq
 * @param {object} [options]
 * @param {string} [options.expectedFile] - Target file path expected for this single-file repair
 * @param {number} [options.maxSize=65536] - Maximum allowable raw response size
 * @returns {{
 *   valid: boolean,
 *   data?: import("zod").infer<typeof RemediationResponseSchema>,
 *   reason?: string
 * }}
 */
export function parseAndValidatePatchResponse(rawResponse, options = {}) {
  const { expectedFile, maxSize = 65536 } = options;

  if (!rawResponse || typeof rawResponse !== "string" || !rawResponse.trim()) {
    return { valid: false, reason: "Response is empty or not a string." };
  }

  if (rawResponse.length > maxSize) {
    return { valid: false, reason: `Response exceeded maximum size limit (${rawResponse.length} > ${maxSize} bytes).` };
  }

  // 1. Safe markdown fence normalization
  const normalized = normalizeJsonFences(rawResponse);

  // 2. Strict JSON parsing
  let parsed;
  try {
    parsed = JSON.parse(normalized);
  } catch (jsonErr) {
    return { valid: false, reason: `Invalid JSON received from AI: ${jsonErr.message}` };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { valid: false, reason: "Response must be a single JSON object." };
  }

  // 3. Schema validation via Zod
  const schemaResult = RemediationResponseSchema.safeParse(parsed);
  if (!schemaResult.success) {
    const issues = schemaResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return { valid: false, reason: `Schema validation failed: ${issues}` };
  }

  const data = schemaResult.data;

  // 4. Path traversal & security checks
  const normalizedPath = data.file.replace(/\\/g, "/");
  if (
    normalizedPath.includes("..") ||
    normalizedPath.startsWith("/") ||
    /^[a-zA-Z]:/.test(normalizedPath)
  ) {
    return { valid: false, reason: `Security violation: Path '${data.file}' attempts directory traversal or is absolute.` };
  }

  // 5. Target file authorization check (single file enforcement)
  if (expectedFile) {
    const cleanExpected = expectedFile.replace(/\\/g, "/").replace(/^\.\//, "");
    const cleanFile = normalizedPath.replace(/^\.\//, "");
    if (cleanFile !== cleanExpected && !cleanFile.endsWith(cleanExpected) && !cleanExpected.endsWith(cleanFile)) {
      return {
        valid: false,
        reason: `Target file mismatch: Expected '${expectedFile}', but patch targeted '${data.file}'.`,
      };
    }
  }

  // 6. Fix proposed checks: non-empty patch and valid unified diff
  if (data.status === "fix_proposed") {
    if (!data.patch || !data.patch.trim()) {
      return { valid: false, reason: "Empty patch received for 'fix_proposed' status." };
    }

    if (!isValidUnifiedDiff(data.patch)) {
      return { valid: false, reason: "Patch is not a valid unified diff (missing @@ -... +... @@ hunk headers or diff markers)." };
    }
  }

  return { valid: true, data };
}

