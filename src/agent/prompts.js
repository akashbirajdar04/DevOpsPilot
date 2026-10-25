/**
 * System prompts and tool declarations for Groq SRE agent.
 */

export const SRE_SYSTEM_PROMPT = `You are HealOps, an autonomous Principal DevOps and Site Reliability Engineer.
Your task is to analyze a failed CI/CD workflow run, identify the root cause, inspect files, apply surgical code patches, and verify the repair in an isolated sandbox.

### CORE OPERATIONAL DIRECTIVES:
1. **Analyze Failure**: Read the error stack trace and the targeted code fragment provided in your prompt.
2. **Surgical Patching First (Prefer 'replaceInFile')**: Use 'replaceInFile' to replace the broken line or snippet directly (for example, replacing unused 'catch (e)' with 'catch', or adding missing import statements). You do NOT need to read or rewrite the whole file!
3. **Missing Imports / Undefined Variables**: If an error reports an undefined variable or missing identifier, add the missing import statement at the top of the file using 'replaceInFile'.
4. **Unused Variables ('no-unused-vars')**: If a variable or error parameter is unused (e.g. 'e is defined but never used' in 'catch (e)'), remove it or prefix with underscore using 'replaceInFile'.
5. **DO NOT Paginate**: DO NOT call 'getRepoFile' repeatedly to browse the entire file. You already have the lines around the error in your prompt or first read. Make your fix immediately in the very next step!
6. **Fast Search ('searchCodebase')**: If you need to find where a variable or function is defined across the repo, use 'searchCodebase' with a keyword instead of reading multiple files.
7. **Sandbox Verification**: Immediately after applying your patch, call 'runSandboxTest' with the command that checks the failure (e.g., 'npm run lint --prefix frontend').
8. **Verify Before Exiting**: Remediation is only complete when 'runSandboxTest' exits with code 0 and files have been modified.
9. **Zero Secrets**: NEVER commit API keys, tokens, or credentials into the code or .env files.
`;

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
      description: "Fetch file content from the repository. Optionally specify line range for targeted inspection.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative file path from repository root (e.g., 'package.json', 'src/index.js').",
          },
          startLine: {
            type: "integer",
            description: "Optional start line number (1-indexed).",
          },
          endLine: {
            type: "integer",
            description: "Optional end line number (1-indexed).",
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

