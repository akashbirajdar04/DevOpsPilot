"""Agent workspace tools for directory inspection, file reading/writing, and sandbox validation."""

import json
import logging
from pathlib import Path
from typing import List, Optional, Set

from app.models.schema import SandboxCommandResult
from app.services.sandbox import DockerSandbox

logger = logging.getLogger(__name__)


class WorkspaceTools:
    """Provides safe, sandboxed tool primitives for the LLM agent within a specific workspace."""

    def __init__(self, workspace_path: Path, sandbox: Optional[DockerSandbox] = None):
        self.workspace_path = workspace_path.resolve()
        self.sandbox = sandbox or DockerSandbox()
        self.modified_files: Set[str] = set()
        self.executed_commands: List[SandboxCommandResult] = []
        self.last_test_command: Optional[str] = None
        self.last_test_result: Optional[SandboxCommandResult] = None

    def _resolve_safe_path(self, relative_path: str) -> Path:
        """Ensure file path stays strictly within the workspace directory."""
        # Strip leading slashes to prevent root escapes
        clean_rel = relative_path.lstrip("/\\")
        target = (self.workspace_path / clean_rel).resolve()
        if not str(target).startswith(str(self.workspace_path)):
            raise ValueError(
                f"Security violation: path '{relative_path}' traverses outside workspace directory."
            )
        return target

    def list_directory(self, directory_path: str = ".") -> str:
        """
        List files and subdirectories at the given relative directory path.
        Returns a formatted listing of items.
        """
        try:
            target = self._resolve_safe_path(directory_path)
            if not target.exists():
                return f"Error: Directory '{directory_path}' does not exist."
            if not target.is_dir():
                return f"Error: '{directory_path}' is not a directory."

            items = []
            for child in target.iterdir():
                rel = child.relative_to(self.workspace_path).as_posix()
                if child.name in {".git", ".venv", "__pycache__", "node_modules"}:
                    continue
                type_str = "DIR " if child.is_dir() else "FILE"
                items.append(f"[{type_str}] {rel}")

            return "\n".join(sorted(items)) if items else "(Empty directory)"
        except Exception as e:
            return f"Error listing directory '{directory_path}': {str(e)}"

    def read_workspace_file(self, file_path: str) -> str:
        """
        Read and return the text content of a file relative to workspace root.
        """
        try:
            target = self._resolve_safe_path(file_path)
            if not target.exists():
                return f"Error: File '{file_path}' does not exist."
            if not target.is_file():
                return f"Error: '{file_path}' is a directory, not a file."

            content = target.read_text(encoding="utf-8", errors="replace")
            return content
        except Exception as e:
            return f"Error reading file '{file_path}': {str(e)}"

    def write_workspace_file(self, file_path: str, content: str) -> str:
        """
        Write or overwrite full text content to a file at file_path.
        Automatically creates parent directories if needed.
        """
        try:
            target = self._resolve_safe_path(file_path)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")

            rel_str = target.relative_to(self.workspace_path).as_posix()
            self.modified_files.add(rel_str)
            logger.info("Agent wrote file: %s", rel_str)
            return f"Successfully wrote {len(content)} characters to '{rel_str}'."
        except Exception as e:
            return f"Error writing file '{file_path}': {str(e)}"

    def patch_workspace_file(self, file_path: str, old_str: str, new_str: str) -> str:
        """
        Replace an exact string occurrence with new content in file_path.
        """
        try:
            target = self._resolve_safe_path(file_path)
            if not target.exists():
                return f"Error: File '{file_path}' does not exist."

            content = target.read_text(encoding="utf-8")
            if old_str not in content:
                return f"Error: The target string was not found in '{file_path}'."

            occurrences = content.count(old_str)
            updated_content = content.replace(old_str, new_str, 1)
            target.write_text(updated_content, encoding="utf-8")

            rel_str = target.relative_to(self.workspace_path).as_posix()
            self.modified_files.add(rel_str)
            logger.info("Agent patched file: %s (occurrences: %d)", rel_str, occurrences)
            return f"Successfully replaced target block in '{rel_str}'."
        except Exception as e:
            return f"Error patching file '{file_path}': {str(e)}"

    def execute_sandbox_command(self, command: str) -> str:
        """
        Execute a test, build, or verification command inside the sandbox environment.
        Returns the command output, exit code, and execution time.
        """
        logger.info("Agent executing sandbox command: %s", command)
        self.last_test_command = command
        result = self.sandbox.execute_command(self.workspace_path, command)
        self.last_test_result = result
        self.executed_commands.append(result)

        status_text = "PASSED (Exit code: 0)" if result.exit_code == 0 else f"FAILED (Exit code: {result.exit_code})"
        output = {
            "status": status_text,
            "exit_code": result.exit_code,
            "timed_out": result.timed_out,
            "stdout": result.stdout[-2000:] if len(result.stdout) > 2000 else result.stdout,
            "stderr": result.stderr[-2000:] if len(result.stderr) > 2000 else result.stderr,
            "duration_seconds": result.execution_time_seconds,
        }
        return json.dumps(output, indent=2)

    # --------------------------------------------------------------------------
    # Explicit Aliases matching Specification:
    # read_repo_file, apply_code_patch, run_sandbox_command
    # --------------------------------------------------------------------------
    def read_repo_file(self, path: str) -> str:
        """Read repository file content relative to workspace root."""
        return self.read_workspace_file(file_path=path)

    def apply_code_patch(self, path: str, old_code: str, new_code: str) -> str:
        """Apply surgical code patch replacing old_code with new_code."""
        return self.patch_workspace_file(file_path=path, old_str=old_code, new_str=new_code)

    def run_sandbox_command(self, cmd: str) -> str:
        """Run build, test, or verification command inside ephemeral sandbox."""
        return self.execute_sandbox_command(command=cmd)
