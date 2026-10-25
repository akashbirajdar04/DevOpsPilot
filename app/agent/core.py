"""Agentic Loop Controller orchestrating Diagnosis, Tool Calling, Sandbox Validation, and PR Delivery."""

import json
import logging
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional
import httpx

from app.agent.prompts import DIAGNOSIS_USER_TEMPLATE, SRE_SYSTEM_PROMPT
from app.agent.tools import WorkspaceTools
from app.config import get_settings
from app.models.schema import RemediationResult
from app.services.github_client import GitHubClient
from app.services.sandbox import DockerSandbox, WorkspaceManager
from app.services.security import SecretScanner

logger = logging.getLogger(__name__)


class AgenticLoopController:
    """Finite State Machine / Controller managing autonomous remediation iterations with Gemini or Groq."""

    def __init__(
        self,
        workspace_manager: Optional[WorkspaceManager] = None,
        docker_sandbox: Optional[DockerSandbox] = None,
        github_client: Optional[GitHubClient] = None,
    ):
        self.settings = get_settings()
        self.workspace_manager = workspace_manager or WorkspaceManager()
        self.docker_sandbox = docker_sandbox or DockerSandbox()
        self.github_client = github_client or GitHubClient()

    async def run_remediation(
        self,
        run_id: int,
        job_id: int,
        repo_full_name: str,
        clone_url: str,
        head_branch: str,
        error_log_window: str,
        step_name: Optional[str] = "Build / Test",
    ) -> RemediationResult:
        """
        Execute full autonomous remediation lifecycle:
        1. Setup workspace & fix branch: fix/ci-failure-{job_id}
        2. Finite state loop (Diagnose -> Tools -> Sandbox Test -> Evaluate)
        3. Pre-commit secret scanning
        4. Branch push and PR creation
        """
        fix_branch_name = f"fix/ci-failure-{job_id}"
        workspace_path: Optional[Path] = None

        try:
            # 1. Prepare Workspace & isolate
            logger.info("Initializing isolated workspace for run %d (job %d)", run_id, job_id)
            workspace_path = self.workspace_manager.clone_or_checkout(
                run_id=run_id,
                job_id=job_id,
                repo_url=clone_url,
                ref=head_branch,
                auth_token=self.github_client.get_token(),
            )

            # Create fix branch
            self.workspace_manager.create_fix_branch(workspace_path, fix_branch_name)

            # Initialize tools for this workspace
            tools = WorkspaceTools(workspace_path=workspace_path, sandbox=self.docker_sandbox)

            # 2. Run Agent State Loop
            success, iterations, root_cause_summary = await self._execute_agent_loop(
                run_id=run_id,
                job_id=job_id,
                repo_full_name=repo_full_name,
                head_branch=head_branch,
                step_name=step_name or "Test",
                error_log_window=error_log_window,
                tools=tools,
            )

            if not success:
                logger.warning(
                    "Remediation failed after %d iterations for job %d",
                    iterations,
                    job_id,
                )
                return RemediationResult(
                    job_id=job_id,
                    run_id=run_id,
                    repo_full_name=repo_full_name,
                    branch_name=fix_branch_name,
                    success=False,
                    iterations_used=iterations,
                    error_message=f"Failed to resolve CI failure within {iterations} retry iterations.",
                    modified_files=list(tools.modified_files),
                )

            # 3. Secret Scanning Pass (Gitleaks / Regex scanner)
            diff_content = self.workspace_manager.get_git_diff(workspace_path)
            if self.settings.enable_secret_scanning:
                scan_res = SecretScanner.scan_diff(diff_content)
                if not scan_res.passed:
                    violations = ", ".join(scan_res.detected_violations)
                    logger.critical("Secret scan failed on patch! Violations: %s", violations)
                    return RemediationResult(
                        job_id=job_id,
                        run_id=run_id,
                        repo_full_name=repo_full_name,
                        branch_name=fix_branch_name,
                        success=False,
                        iterations_used=iterations,
                        error_message=f"Security violation: Secret leak detected in generated patch ({violations}).",
                    )

            # 4. Commit changes
            commit_msg = f"fix(ci): automated remediation for failed run #{job_id}\n\n{root_cause_summary}"
            self.workspace_manager.commit_changes(workspace_path, commit_msg)

            # 5. Push branch and open PR
            pr_url = None
            token = self.github_client.get_token()
            if token:
                try:
                    self.workspace_manager.push_branch(workspace_path, fix_branch_name)

                    test_cmd = tools.last_test_command or "npm test"
                    test_out = (
                        tools.last_test_result.stdout if tools.last_test_result else "Passed"
                    )

                    pr_body = self.github_client.generate_pr_body(
                        job_id=job_id,
                        run_id=run_id,
                        root_cause_analysis=root_cause_summary,
                        modified_files=list(tools.modified_files),
                        test_command=test_cmd,
                        test_output=test_out,
                        iterations=iterations,
                    )

                    pr_info = self.github_client.create_pull_request(
                        repo_full_name=repo_full_name,
                        title=f"fix(ci): automated remediation for failed run #{job_id}",
                        body=pr_body,
                        head_branch=fix_branch_name,
                        base_branch=head_branch,
                    )
                    pr_url = pr_info.get("html_url")
                except Exception as e:
                    logger.error("Error pushing branch or opening PR: %s", e)

            return RemediationResult(
                job_id=job_id,
                run_id=run_id,
                repo_full_name=repo_full_name,
                branch_name=fix_branch_name,
                success=True,
                iterations_used=iterations,
                pr_url=pr_url,
                root_cause_summary=root_cause_summary,
                modified_files=list(tools.modified_files),
            )

        except Exception as e:
            logger.exception("Unexpected error during remediation for job %d: %s", job_id, e)
            return RemediationResult(
                job_id=job_id,
                run_id=run_id,
                repo_full_name=repo_full_name,
                branch_name=fix_branch_name,
                success=False,
                iterations_used=0,
                error_message=str(e),
            )

    async def _execute_agent_loop(
        self,
        run_id: int,
        job_id: int,
        repo_full_name: str,
        head_branch: str,
        step_name: str,
        error_log_window: str,
        tools: WorkspaceTools,
    ) -> tuple[bool, int, str]:
        """Route to active LLM Provider (Google AI Studio Gemini 2.5 Flash or Groq Cloud Llama 3.3)."""
        provider = self.settings.llm_provider.lower()
        if provider == "groq" or (self.settings.groq_api_key and not self.settings.gemini_api_key):
            return await self._execute_groq_loop(
                run_id, job_id, repo_full_name, head_branch, step_name, error_log_window, tools
            )
        else:
            return await self._execute_gemini_loop(
                run_id, job_id, repo_full_name, head_branch, step_name, error_log_window, tools
            )

    async def _execute_gemini_loop(
        self,
        run_id: int,
        job_id: int,
        repo_full_name: str,
        head_branch: str,
        step_name: str,
        error_log_window: str,
        tools: WorkspaceTools,
    ) -> tuple[bool, int, str]:
        """Runs the LLM agent tool-calling loop with Google Gemini 2.5 Flash."""
        max_retries = self.settings.max_retry_iterations
        api_key = self.settings.gemini_api_key

        if not api_key:
            logger.warning("GEMINI_API_KEY is not set. Running in diagnostic inspection mode.")
            return False, 1, "Gemini API key not configured. Agent could not run LLM diagnosis."

        try:
            from google import genai
            from google.genai import types

            client = genai.Client(api_key=api_key)

            tool_functions: List[Callable] = [
                tools.list_directory,
                tools.read_workspace_file,
                tools.write_workspace_file,
                tools.patch_workspace_file,
                tools.execute_sandbox_command,
                tools.read_repo_file,
                tools.apply_code_patch,
                tools.run_sandbox_command,
            ]

            initial_files = tools.list_directory(".")
            user_prompt = DIAGNOSIS_USER_TEMPLATE.format(
                branch=head_branch,
                repo=repo_full_name,
                job_id=job_id,
                run_id=run_id,
                step_name=step_name,
                log_snippet=error_log_window,
                workspace_files=initial_files,
            )

            chat = client.chats.create(
                model=self.settings.gemini_model,
                config=types.GenerateContentConfig(
                    system_instruction=SRE_SYSTEM_PROMPT,
                    temperature=0.1,
                    tools=tool_functions,
                ),
            )

            current_message = user_prompt
            iteration = 0
            root_cause = "Autonomous remediation completed and verified."

            while iteration < max_retries:
                iteration += 1
                logger.info("Executing Gemini remediation iteration %d/%d", iteration, max_retries)

                response = chat.send_message(current_message)
                root_cause = response.text or root_cause

                if tools.last_test_result and tools.last_test_result.exit_code == 0:
                    logger.info("Sandbox verification test passed on iteration %d!", iteration)
                    return True, iteration, root_cause

                if tools.last_test_result and tools.last_test_result.exit_code != 0:
                    current_message = (
                        f"Validation command '{tools.last_test_command}' failed with exit code "
                        f"{tools.last_test_result.exit_code}.\n"
                        f"Stderr:\n{tools.last_test_result.stderr[-1000:]}\n"
                        f"Stdout:\n{tools.last_test_result.stdout[-1000:]}\n"
                        "Please adjust your patch and re-verify in the sandbox."
                    )
                else:
                    break

            success = bool(tools.last_test_result and tools.last_test_result.exit_code == 0)
            return success, iteration, root_cause

        except Exception as e:
            logger.error("Gemini Agent execution error: %s", e)
            return False, 1, f"Gemini agent execution exception: {str(e)}"

    async def _execute_groq_loop(
        self,
        run_id: int,
        job_id: int,
        repo_full_name: str,
        head_branch: str,
        step_name: str,
        error_log_window: str,
        tools: WorkspaceTools,
    ) -> tuple[bool, int, str]:
        """Runs the LLM agent tool-calling loop with Groq Cloud (Llama 3.3 70B)."""
        max_retries = self.settings.max_retry_iterations
        api_key = self.settings.groq_api_key

        if not api_key:
            logger.warning("GROQ_API_KEY is not set.")
            return False, 1, "Groq API key not configured."

        # Groq OpenAI-compatible Tool Specifications
        groq_tools = [
            {
                "type": "function",
                "function": {
                    "name": "read_repo_file",
                    "description": "Read file contents relative to repository root.",
                    "parameters": {
                        "type": "object",
                        "properties": {"path": {"type": "string"}},
                        "required": ["path"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "apply_code_patch",
                    "description": "Replace an exact block of code with new content.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "path": {"type": "string"},
                            "old_code": {"type": "string"},
                            "new_code": {"type": "string"},
                        },
                        "required": ["path", "old_code", "new_code"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "write_workspace_file",
                    "description": "Write or create a file with full content.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "file_path": {"type": "string"},
                            "content": {"type": "string"},
                        },
                        "required": ["file_path", "content"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "list_directory",
                    "description": "List files and directories in repository.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "directory_path": {"type": "string", "default": "."}
                        },
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "run_sandbox_command",
                    "description": "Run test or build command in safe sandbox.",
                    "parameters": {
                        "type": "object",
                        "properties": {"cmd": {"type": "string"}},
                        "required": ["cmd"],
                    },
                },
            },
        ]

        initial_files = tools.list_directory(".")
        user_prompt = DIAGNOSIS_USER_TEMPLATE.format(
            branch=head_branch,
            repo=repo_full_name,
            job_id=job_id,
            run_id=run_id,
            step_name=step_name,
            log_snippet=error_log_window,
            workspace_files=initial_files,
        )

        messages = [
            {"role": "system", "content": SRE_SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ]

        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

        iteration = 0
        root_cause = "Autonomous remediation completed via Groq Llama 3.3."

        async with httpx.AsyncClient(timeout=45.0) as client:
            while iteration < max_retries:
                iteration += 1
                logger.info("Executing Groq remediation iteration %d/%d", iteration, max_retries)

                payload = {
                    "model": self.settings.groq_model,
                    "messages": messages,
                    "tools": groq_tools,
                    "tool_choice": "auto",
                    "temperature": 0.1,
                }

                resp = await client.post(
                    "https://api.groq.com/openai/v1/chat/completions",
                    headers=headers,
                    json=payload,
                )
                if resp.status_code != 200:
                    logger.error("Groq API error: HTTP %d - %s", resp.status_code, resp.text)
                    return False, iteration, f"Groq API error: {resp.text}"

                data = resp.json()
                choice = data["choices"][0]
                msg = choice["message"]
                messages.append(msg)

                tool_calls = msg.get("tool_calls")
                if not tool_calls:
                    root_cause = msg.get("content") or root_cause
                    break

                for tc in tool_calls:
                    fn_name = tc["function"]["name"]
                    fn_args = json.loads(tc["function"]["arguments"] or "{}")
                    call_id = tc["id"]

                    res_content = ""
                    if fn_name in {"read_repo_file", "read_workspace_file"}:
                        path = fn_args.get("path") or fn_args.get("file_path", "")
                        res_content = tools.read_workspace_file(path)
                    elif fn_name in {"apply_code_patch", "patch_workspace_file"}:
                        path = fn_args.get("path") or fn_args.get("file_path", "")
                        old_s = fn_args.get("old_code") or fn_args.get("old_str", "")
                        new_s = fn_args.get("new_code") or fn_args.get("new_str", "")
                        res_content = tools.patch_workspace_file(path, old_s, new_s)
                    elif fn_name == "write_workspace_file":
                        res_content = tools.write_workspace_file(
                            fn_args.get("file_path", ""), fn_args.get("content", "")
                        )
                    elif fn_name == "list_directory":
                        res_content = tools.list_directory(fn_args.get("directory_path", "."))
                    elif fn_name in {"run_sandbox_command", "execute_sandbox_command"}:
                        cmd = fn_args.get("cmd") or fn_args.get("command", "")
                        res_content = tools.execute_sandbox_command(cmd)

                    messages.append({
                        "role": "tool",
                        "tool_call_id": call_id,
                        "name": fn_name,
                        "content": res_content,
                    })

                if tools.last_test_result and tools.last_test_result.exit_code == 0:
                    logger.info("Sandbox test passed on Groq iteration %d!", iteration)
                    return True, iteration, root_cause

        success = bool(tools.last_test_result and tools.last_test_result.exit_code == 0)
        return success, iteration, root_cause
