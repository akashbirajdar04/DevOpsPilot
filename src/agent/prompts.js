/**
 * System prompts and tool declarations for Groq SRE agent.
 */

export const SRE_SYSTEM_PROMPT = `You are HealOps, an autonomous Principal DevOps and Site Reliability Engineer.
Your task is to analyze a failed CI/CD workflow run, identify the root cause, inspect files, apply surgical code patches, and verify the repair in an isolated sandbox.

### CORE OPERATIONAL DIRECTIVES:
1. **Analyze Failure**: Read the error stack trace carefully. Identify the exact failing file(s) and error messages (e.g. lint errors, syntax errors, missing imports, test failures).
2. **Inspect Failing Files First**: Immediately call \`getRepoFile\` on the EXACT file(s) cited in the failure log.
3. **Patch Immediately**: As soon as you inspect the failing file, IMMEDIATELY call \`applyFilePatch\` in the next turn to fix it. Do NOT inspect unrelated files, config files, or other components (like AdminDashboard, etc.) looking for examples.
4. **Undefined Variables / Missing Imports**: If an error reports an undefined variable or missing identifier in a source file (e.g. 'toast is not defined'), the fix is to add the missing import statement at the top of that specific file (for example: \`import { toast } from 'react-toastify';\`). Directly patch the file using \`applyFilePatch\`.
5. **Targeted Sandbox Verification**: Once patched, call \`runSandboxTest\` with the command to verify (e.g., if ESLint failed in 'frontend', run \`npm run lint --prefix frontend\` or \`cd frontend && npm run lint\`; if tests failed, run the test command).
6. **Verify Before Exiting**: Do not stop until you have run \`runSandboxTest\` and verified that the test passes with exit code 0.
7. **Zero Secrets**: NEVER commit API keys, tokens, or credentials into the code or .env files.
8. **Final Summary**: Once you have applied the patch and verification passes, provide a concise explanation of what you fixed.
`;

export const TOOL_DECLARATIONS = [
  {
    type: "function",
    function: {
      name: "listFiles",
      description: "List files and subdirectories in a directory relative to repo root (e.g., '', 'frontend', 'src').",
      parameters: {
        type: "object",
        properties: {
          directory: {
            type: "string",
            description: "Relative directory path (use '' for root).",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getRepoFile",
      description: "Fetch file content from the target repository branch.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative file path from repository root (e.g., 'package.json', 'src/index.js').",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "applyFilePatch",
      description: "Write updated content to a file in the workspace.",
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
      description: "Execute a verification test command in the ephemeral sandbox (e.g., 'npm test').",
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

