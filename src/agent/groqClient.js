import Groq from "groq-sdk";
import { parseAndValidatePatchResponse } from "./patchSchema.js";

/**
 * System prompt instructing Groq to return strict JSON unified diff patch.
 */
export const GROQ_STRUCTURED_SRE_PROMPT = `You are an automated Site Reliability Engineer (SRE) and static code repair agent.
Inspect the broken code and error diagnostics. Propose a surgical, minimal unified diff patch to fix the error.

CRITICAL INSTRUCTIONS:
1. Return ONLY a single valid JSON object matching this schema:
{
  "status": "fix_proposed",
  "file": "<target file path>",
  "fix_type": "syntax_error" | "import_error" | "type_error" | "linter_rule" | "dependency_error" | "logic_error" | "other",
  "patch": "@@ -start,count +start,count @@\\n-broken\\n+fixed",
  "explanation": "Concise reason for the fix"
}

2. Patch Rules:
   - The patch field MUST be a valid unified diff hunk starting with '@@ -... +... @@'.
   - Never output omission comments (e.g., '// rest of code').
   - For unused catch parameters: rewrite 'catch (e)' to ECMAScript standard optional catch binding 'catch {}'. Never rename to '_e'.
   - For unused imports: remove the unused specifier or the whole statement. Never rename identifiers in module import paths.
   - For React hooks: keep inside component bodies, never in global module scope. For missing deps, add state/props primitives, or wrap helper functions in useCallback/move inside useEffect.
   - Do NOT execute commands.
   - If unable to fix, return { "status": "no_fix", "file": "<path>", "fix_type": "other", "patch": "", "explanation": "reason" }`;

/**
 * Mutex for strictly serializing AI requests to prevent Groq TPM / concurrency bursts.
 */
class RequestMutex {
  constructor() {
    this._queue = Promise.resolve();
  }

  runExclusive(fn) {
    const result = this._queue.then(() => fn());
    this._queue = result.catch(() => {});
    return result;
  }
}

const globalGroqMutex = new RequestMutex();

/**
 * Extract retry delay from HTTP 429 response or error message.
 * @param {any} err
 * @returns {number|null} Delay in milliseconds
 */
export function extractRetryAfterMs(err) {
  if (!err) return null;

  // 1. Check HTTP header
  const headerVal = err.headers?.get ? err.headers.get("retry-after") : err.headers?.["retry-after"];
  if (headerVal) {
    const parsedSec = parseFloat(headerVal);
    if (!isNaN(parsedSec)) {
      return Math.ceil(parsedSec * 1000);
    }
  }

  // 2. Check error message string for "try again in Xs" or "wait Xs"
  const msg = err.message || "";
  const matchSec = msg.match(/(?:try again in|wait|retry after)\s*([0-9.]+)\s*s(?:ec(?:ond)?s?)?/i);
  if (matchSec) {
    const sec = parseFloat(matchSec[1]);
    if (!isNaN(sec)) {
      return Math.ceil(sec * 1000);
    }
  }

  const matchMs = msg.match(/(?:try again in|wait|retry after)\s*([0-9.]+)\s*ms/i);
  if (matchMs) {
    const ms = parseFloat(matchMs[1]);
    if (!isNaN(ms)) {
      return Math.ceil(ms);
    }
  }

  return null;
}

export class GroqRemediationClient {
  /**
   * @param {object} options
   * @param {string} [options.apiKey]
   * @param {string} [options.model="openai/gpt-oss-120b"]
   * @param {number} [options.maxRetries=3]
   * @param {number} [options.baseDelayMs=1000]
   * @param {number} [options.maxDelayMs=15000]
   * @param {object} [options.logger=console]
   */
  constructor({
    apiKey = process.env.GROQ_API_KEY,
    model = process.env.GROQ_MODEL || "openai/gpt-oss-120b",
    maxRetries = 3,
    baseDelayMs = 1000,
    maxDelayMs = 15000,
    logger = console,
  } = {}) {
    this.apiKey = apiKey;
    this.model = model;
    this.maxRetries = maxRetries;
    this.baseDelayMs = baseDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.logger = logger;

    if (this.apiKey) {
      this.groq = new Groq({ apiKey: this.apiKey });
    }
  }

  /**
   * Send a single-shot structured patch generation request to Groq with rate-limit backoff.
   * Serialized across threads to enforce rate limits.
   *
   * @param {object} params
   * @param {string} params.targetFile
   * @param {string} params.errorDetails
   * @param {string} params.codeContext
   * @returns {Promise<{
   *   success: boolean,
   *   data?: import("./patchSchema.js").RemediationResponseSchema,
   *   rawResponse?: string,
   *   tokenUsage: { promptTokens: number, completionTokens: number, totalTokens: number },
   *   retries: number,
   *   error?: string
   * }>}
   */
  async requestStructuredPatch({ targetFile, errorDetails, codeContext }) {
    if (!this.groq) {
      return {
        success: false,
        tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        retries: 0,
        error: "GROQ_API_KEY is not configured.",
      };
    }

    const userPrompt = `Target File: ${targetFile}

Failure Diagnostics:
${errorDetails}

Relevant Code Context:
\`\`\`
${codeContext}
\`\`\`

TASK:
Identify the bug and generate a unified diff patch to fix it. Return ONLY the strict JSON object.`;

    return globalGroqMutex.runExclusive(async () => {
      let attempts = 0;
      let totalRetries = 0;
      let lastErr = null;

      while (attempts <= this.maxRetries) {
        try {
          this.logger.info?.(
            `[Groq (${this.model})] Dispatching patch request for '${targetFile}' (attempt ${attempts + 1}/${this.maxRetries + 1})...`
          );

          const completion = await this.groq.chat.completions.create({
            model: this.model,
            messages: [
              { role: "system", content: GROQ_STRUCTURED_SRE_PROMPT },
              { role: "user", content: userPrompt },
            ],
            temperature: 0.1,
            max_tokens: 2048,
          });

          const rawContent = completion?.choices?.[0]?.message?.content || "";
          const usage = completion?.usage || {};
          const tokenUsage = {
            promptTokens: usage.prompt_tokens || 0,
            completionTokens: usage.completion_tokens || 0,
            totalTokens: usage.total_tokens || 0,
          };

          this.logger.info?.(
            `[Groq] Response received for '${targetFile}': ${tokenUsage.totalTokens} tokens (${tokenUsage.promptTokens} in / ${tokenUsage.completionTokens} out).`
          );

          // Validate against strict Zod schema
          const validation = parseAndValidatePatchResponse(rawContent, {
            expectedFile: targetFile,
          });

          if (!validation.valid) {
            this.logger.warn?.(`[Groq] Schema validation rejected for '${targetFile}': ${validation.reason}`);
            return {
              success: false,
              rawResponse: rawContent,
              tokenUsage,
              retries: totalRetries,
              error: `AI response schema validation failed: ${validation.reason}`,
            };
          }

          return {
            success: true,
            data: validation.data,
            rawResponse: rawContent,
            tokenUsage,
            retries: totalRetries,
          };
        } catch (err) {
          lastErr = err;
          const is429 =
            err.status === 429 ||
            err.code === "rate_limit_exceeded" ||
            /rate[_\s]limit|too many requests|429/i.test(err.message || "");

          if (!is429 || attempts >= this.maxRetries) {
            this.logger.error?.(`[Groq Error] Unrecoverable error or max retries exceeded: ${err.message}`);
            break;
          }

          attempts++;
          totalRetries++;

          // Calculate backoff with jitter
          const suggestedDelay = extractRetryAfterMs(err);
          const exponentialDelay = Math.min(
            this.baseDelayMs * Math.pow(2, attempts) + Math.floor(Math.random() * 500),
            this.maxDelayMs
          );
          const waitTimeMs = suggestedDelay || exponentialDelay;

          this.logger.warn?.(
            `[Groq Rate Limit (429)] Backing off for ${waitTimeMs}ms before retry ${attempts}/${this.maxRetries}...`
          );
          await new Promise((resolve) => setTimeout(resolve, waitTimeMs));
        }
      }

      return {
        success: false,
        tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        retries: totalRetries,
        error: lastErr ? `Groq API failure: ${lastErr.message}` : "Max retries exceeded.",
      };
    });
  }
}

