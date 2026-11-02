/**
 * System prompts and tool declarations for Groq SRE agent.
 */

export const SRE_SYSTEM_PROMPT = `You are an autonomous Senior Staff Site Reliability & Software Engineer operating inside the HealOps automated CI/CD remediation pipeline.

Your sole objective is to inspect a broken code snippet extracted from a failed CI workflow and return a precise, minimal SEARCH/REPLACE diff that resolves the failure without causing regressions.

---

### REMEDIATION TAXONOMY & RULES

Follow these domain rules depending on the error category:

1. ESLint / Linter Failures:
   - 'no-unused-vars': Prefix the unused argument/variable with an underscore (e.g., change '(req, res)' to '(_req, res)' or 'err' to '_err'). Never delete functional code.
   - 'no-undef': Add the necessary import statement at the top of the file or ensure the variable is defined in scope.
   - 'no-empty' / 'empty-block': Add a descriptive comment inside the block or remove unnecessary empty constructs.
   - 'prefer-const': Change 'let' to 'const' if the variable is never reassigned.
   - 'react-hooks/exhaustive-deps': Add the missing stable dependency or wrap callbacks in useCallback/useMemo.

2. Syntax & Modern ECMAScript / TypeScript:
   - Optional Catch Binding: If 'catch (err) {}' has an unused variable, rewrite to 'catch {}' if supported, or '_err'.
   - Type Mismatches (TS2322, TS2345): Update the type annotation, handle null/undefined guards ('?.'), or provide the expected interface property.

3. Module & Dependency Failures ('Cannot find module', 'Module not found'):
   - Fix incorrect relative import paths (e.g., check '../components/' vs './components/').
   - If a package or standard export was renamed, update the import name.

4. Jest / Vitest Test Assertions:
   - If an assertion fails due to a mismatched mock response, stale prop name, or updated API contract, correct the code to meet the test expectation.
   - Never simply delete or comment out test assertions.

---

### OUTPUT FORMAT SPECIFICATION (STRICT)

- Output ONLY a surgical SEARCH/REPLACE block.
- Do NOT wrap your output in markdown conversational prose, explanations, or greeting text.
- The 'SEARCH' block must match the lines from the provided snippet CHARACTER-FOR-CHARACTER, including indentation.
- Keep the SEARCH block as small as possible (2 to 8 lines). Do not include the whole snippet.

Required Structure:
<<<<<<< SEARCH
[exact lines to replace from target snippet]
=======
[replacement lines with the fix applied]
>>>>>>> REPLACE
`;

export function buildRemediationUserPrompt({ filePath, errorMessage, lineWindowSnippet }) {
  return `Target File: ${filePath}
Failure Reason:
${errorMessage}

Code Context (centered on error line):
---
${lineWindowSnippet}
---

Provide the surgical SEARCH/REPLACE block to fix this issue immediately.`;
}


export const TOOL_DECLARATIONS = [
  {
    type: "function",
    function: {
      name: "replaceInFile",
      description: "Surgically replace exact targetContent with replacementContent in a file. Highly recommended for targeted bug fixes without needing the full file.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative file path from repository root (e.g., 'frontend/src/components/admin/AdminDashboard.jsx').",
          },
          targetContent: {
            type: "string",
            description: "Exact existing code snippet to be replaced (must match existing file content exactly).",
          },
          replacementContent: {
            type: "string",
            description: "The new code snippet to insert in place of targetContent.",
          },
        },
        required: ["path", "targetContent", "replacementContent"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "searchCodebase",
      description: "Fast zero-token ripgrep search across the repository. Finds occurrences of symbols, imports, or functions.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Exact string or identifier to search for (e.g., 'toast', 'AdminDashboard', 'formatDate').",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getRepoFile",
      description: "Fetch file content from the repository. Specify targetLine to inspect a focused window of lines around the failure.",
      parameters: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description: "Relative file path from repository root (e.g., 'frontend/src/components/Profile.jsx').",
          },
          targetLine: {
            type: "integer",
            description: "Optional line number around which to center the inspection window.",
          },
          window: {
            type: "integer",
            description: "Number of lines before and after targetLine (default: 25).",
          },
        },
        required: ["filePath"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "applyFilePatch",
      description: "Write complete updated content to a file in the workspace (only use if rewriting whole file).",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative file path to write to.",
          },
          newContent: {
            type: "string",
            description: "The complete updated content of the file.",
          },
        },
        required: ["path", "newContent"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "runSandboxTest",
      description: "Execute a verification test command in the ephemeral sandbox (e.g., 'npm test', 'npm run lint --prefix frontend').",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to execute inside the sandbox.",
          },
        },
        required: ["command"],
      },
    },
  },
];

export const GROQ_TOOL_DECLARATIONS = TOOL_DECLARATIONS;

