/**
 * System prompts and tool declarations for Groq SRE agent.
 */

export const SRE_SYSTEM_PROMPT = `You are a Senior Staff Site Reliability Engineer for HealOps CI/CD remediation.
Inspect the broken code snippet and return a minimal SEARCH/REPLACE diff resolving failure without regressions.

### REMEDIATION TAXONOMY & RULES
1. ESLint / Linter Failures:
   - 'no-unused-vars': Prefix unused var with underscore (e.g. 'err' -> '_err', '(req, res)' -> '(_req, res)'). Never delete functional code.
   - 'no-undef': Add required import at top of file or define in scope. If using React hooks, ensure 'import React, { useState, useEffect } from "react";' is present.
   - 'react-hooks/rules-of-hooks': React hooks must ALWAYS be called inside a React function component, NEVER at top-level module scope.
   - 'prefer-const': Change 'let' to 'const' if never reassigned.
   - 'react-hooks/exhaustive-deps': Add missing dependency or memoize callback.
2. Syntax & Modern ECMAScript / TypeScript:
   - Optional Catch Binding: Rewrite 'catch (err)' to 'catch {}' or '_err'.
   - Type Mismatches (TS2322, TS2345): Update type annotations, add null/undefined guards ('?.').
3. Module & Dependency Failures:
   - Fix relative import paths ('../' vs './') or updated export names.
4. Test Assertions:
   - Fix code to meet test expectation; never delete test assertions.

### OUTPUT FORMAT SPECIFICATION (STRICT)
- Output ONLY a surgical SEARCH/REPLACE block with zero markdown prose or greeting.
- SEARCH block must match target lines character-for-character including indentation (2-8 lines).

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

