"""Agentic Loop Controller orchestrating Diagnosis, Tool Calling, Sandbox Validation, and PR Delivery."""

import logging
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from app.agent.prompts import DIAGNOSIS_USER_TEMPLATE, SRE_SYSTEM_PROMPT
from app.agent.tools import WorkspaceTools
from app.config import get_settings
from app.models.schema import AgentStepEnum, RemediationResult
from app.services.github_client import GitHubClient
from app.services.sandbox import DockerSandbox, WorkspaceManager
from app.services.security import SecretScanner

logger = logging.getLogger(__name__)


class AgenticLoopController:
    """Finite State Machine / Controller managing autonomous remediation iterations."""

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
                auth_token=self.settings.github_token,
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

            # 3. Secret Scanning Pass
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
            if self.settings.github_token:
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
        """
        Runs the LLM agent tool-calling loop with Gemini 2.5 Flash.
        Falls back to safe iterative repair if API key is not configured.
        """
        max_retries = self.settings.max_retry_iterations
        api_key = self.settings.gemini_api_key

        if not api_key:
            logger.warning("GEMINI_API_KEY is not set. Running in diagnostic inspection mode.")
            return False, 1, "Gemini API key not configured. Agent could not run LLM diagnosis."

        try:
            from google import genai
            from google.genai import types

            client = genai.Client(api_key=api_key)

            # Available tool functions
            tool_functions: List[Callable] = [
                tools.list_directory,
                tools.read_workspace_file,
                tools.write_workspace_file,
                tools.patch_workspace_file,
                tools.execute_sandbox_command,
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

            # Create chat session with tool definitions
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

            # State loop with max iterations
            while iteration < max_retries:
                iteration += 1
                logger.info("Executing remediation iteration %d/%d", iteration, max_retries)

                response = chat.send_message(current_message)
                root_cause = response.text or root_cause

                # Check if sandbox command was executed and succeeded
                if tools.last_test_result and tools.last_test_result.exit_code == 0:
                    logger.info("Sandbox verification test passed on iteration %d!", iteration)
                    return True, iteration, root_cause

                # If test failed or was executed with non-zero exit code, provide feedback
                if tools.last_test_result and tools.last_test_result.exit_code != 0:
                    current_message = (
                        f"Validation command '{tools.last_test_command}' failed with exit code "
                        f"{tools.last_test_result.exit_code}.\n"
                        f"Stderr:\n{tools.last_test_result.stderr[-1000:]}\n"
                        f"Stdout:\n{tools.last_test_result.stdout[-1000:]}\n"
                        "Please adjust your patch and re-verify in the sandbox."
                    )
                else:
                    # Model finished talking without running verification
                    break

            # If loop finished and last test passed
            success = bool(tools.last_test_result and tools.last_test_result.exit_code == 0)
            return success, iteration, root_cause

        except Exception as e:
            logger.error("LLM Agent execution encountered error: %s", e)
            return False, 1, f"Agent execution exception: {str(e)}"
