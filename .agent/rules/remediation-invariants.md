---
trigger: always_on
description: Invariants for fixing CI/CD lint, build, and syntax errors
---

# Remediation & Code Modification Invariants

1. **Zero Truncation Rule**:
   - Never output omission comments (e.g., `// [Remaining lines omitted...]` or `/* rest of code */`).
   - Every file modification must preserve 100% of the surrounding unaffected code.
   - Never emit raw Git conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`).

2. **AST-Compliant JavaScript/TypeScript Modifications**:
   - **Optional Catch Binding**: When fixing `no-unused-vars` in `catch` blocks, rewrite `catch (e)` or `catch (_e)` to standard ECMAScript optional catch binding: `catch {}`. Never rename the parameter to `_e`.
   - **Path Protection**: Never rename identifiers inside import path strings (e.g., `from "../lib/api"` must never become `"../lib/_api"`).
   - **Unused Import Removal**: If an imported variable is unused, delete that specific specifier from the import list. If no specifiers remain, remove the entire `import` statement.
   - **React Hooks**: All React hooks (`useState`, `useEffect`, etc.) must remain inside the body of a component or custom hook. Never leave hook invocations in global/module scope.

3. **Deterministic Sandbox Integrity**:
   - Always run package installs with `NODE_ENV=development` and `--include=dev` so `devDependencies` (like `eslint`, `vite`, `tsc`) are available.
   - Before completing any task, execute verification:
     ```bash
     npm run lint --prefix frontend && npm run build --prefix frontend
     ```
   - If the verification exit code is non-zero, do not commit. Re-inspect errors and adjust.
