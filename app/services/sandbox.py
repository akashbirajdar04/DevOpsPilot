"""Workspace manager and Docker sandbox execution engine."""

import logging
import os
import shutil
import subprocess
import time
from pathlib import Path
from typing import Dict, Optional
import git

from app.config import get_settings
from app.models.schema import SandboxCommandResult

logger = logging.getLogger(__name__)


class WorkspaceManager:
    """Manages isolated local filesystem workspaces and git checkouts for CI jobs."""

    def __init__(self, base_dir: Optional[Path] = None):
        self.settings = get_settings()
        self.base_dir = (base_dir or self.settings.workspace_base_dir).resolve()
        self.base_dir.mkdir(parents=True, exist_ok=True)

    def get_workspace_path(self, run_id: int, job_id: Optional[int] = None) -> Path:
        """Generate isolated directory path for a specific CI run."""
        suffix = f"{run_id}_{job_id}" if job_id else str(run_id)
        return (self.base_dir / f"run_{suffix}").resolve()

    def clone_or_checkout(
        self,
        run_id: int,
        repo_url: str,
        ref: str,
        job_id: Optional[int] = None,
        auth_token: Optional[str] = None,
    ) -> Path:
        """
        Clones repository into an isolated workspace and checks out the target ref.
        If auth_token is provided, embeds it safely into https clone URL.
        """
        workspace_path = self.get_workspace_path(run_id, job_id)

        if workspace_path.exists():
            shutil.rmtree(workspace_path, ignore_errors=True)

        workspace_path.mkdir(parents=True, exist_ok=True)

        # Secure clone URL with token if available
        clone_url = repo_url
        if auth_token and repo_url.startswith("https://"):
            clone_url = repo_url.replace("https://", f"https://x-access-token:{auth_token}@")

        logger.info("Cloning %s into workspace %s", repo_url, workspace_path)
        repo = git.Repo.clone_from(clone_url, str(workspace_path))

        # Checkout specified ref (branch or commit)
        try:
            repo.git.checkout(ref)
        except git.GitCommandError as e:
            logger.warning("Failed to directly checkout %s, attempting fetch: %s", ref, e)
            repo.git.fetch("origin", ref)
            repo.git.checkout("FETCH_HEAD")

        return workspace_path

    def create_fix_branch(self, workspace_path: Path, branch_name: str) -> None:
        """Create and checkout dynamic branch fix/ci-failure-{job_id}."""
        repo = git.Repo(str(workspace_path))
        logger.info("Creating fix branch '%s' in %s", branch_name, workspace_path)
        repo.git.checkout("-B", branch_name)

    def get_git_diff(self, workspace_path: Path) -> str:
        """Return unified diff of all uncommitted modifications in the workspace."""
        repo = git.Repo(str(workspace_path))
        # Track untracked files in diff
        repo.git.add("-N", ".")
        diff_output = repo.git.diff()
        return diff_output

    def commit_changes(
        self,
        workspace_path: Path,
        commit_message: str,
        author_name: str = "Auto-DevOps-Agent",
        author_email: str = "agent@bot.local",
    ) -> str:
        """Stage all modifications and create a git commit."""
        repo = git.Repo(str(workspace_path))
        repo.git.add("-A")
        
        # Configure author
        with repo.config_writer() as config:
            config.set_value("user", "name", author_name)
            config.set_value("user", "email", author_email)

        commit = repo.index.commit(commit_message)
        logger.info("Committed changes with SHA: %s", commit.hexsha)
        return commit.hexsha

    def push_branch(
        self, workspace_path: Path, branch_name: str, force: bool = True
    ) -> None:
        """Push the remediation branch to origin."""
        repo = git.Repo(str(workspace_path))
        origin = repo.remote(name="origin")
        args = ["-u", "origin", branch_name]
        if force:
            args.insert(0, "--force")
        repo.git.push(*args)
        logger.info("Pushed branch %s to remote", branch_name)

    def cleanup(self, workspace_path: Path) -> None:
        """Clean up workspace directory from filesystem."""
        if workspace_path.exists():
            shutil.rmtree(workspace_path, ignore_errors=True)
            logger.info("Cleaned up workspace at %s", workspace_path)


class DockerSandbox:
    """Executes build and test commands inside an ephemeral Docker container or local fallback."""

    def __init__(self):
        self.settings = get_settings()
        self._docker_client = None
        self._is_docker_available = None

    @property
    def is_docker_available(self) -> bool:
        """Check if Docker daemon is responsive."""
        if self._is_docker_available is not None:
            return self._is_docker_available

        if not self.settings.use_docker_sandbox:
            self._is_docker_available = False
            return False

        try:
            import docker
            client = docker.from_env()
            client.ping()
            self._docker_client = client
            self._is_docker_available = True
            logger.info("Docker daemon successfully detected and connected.")
        except Exception as e:
            logger.warning(
                "Docker daemon is not available (%s). Sandboxed commands will fallback to isolated host process.",
                e,
            )
            self._docker_client = None
            self._is_docker_available = False

        return self._is_docker_available

    def execute_command(
        self,
        workspace_path: Path,
        command: str,
        image: Optional[str] = None,
        timeout_seconds: Optional[int] = None,
        env_vars: Optional[Dict[str, str]] = None,
    ) -> SandboxCommandResult:
        """
        Execute command inside Docker container if Docker is accessible.
        Otherwise executes safely inside workspace directory with process limits.
        """
        timeout = timeout_seconds or self.settings.docker_timeout_seconds
        image_name = image or self.settings.docker_sandbox_image
        start_time = time.time()

        if self.is_docker_available and self._docker_client:
            return self._run_in_docker(
                workspace_path, command, image_name, timeout, env_vars
            )
        else:
            return self._run_in_subprocess(
                workspace_path, command, timeout, env_vars
            )

    def _run_in_docker(
        self,
        workspace_path: Path,
        command: str,
        image_name: str,
        timeout: int,
        env_vars: Optional[Dict[str, str]] = None,
    ) -> SandboxCommandResult:
        """Run command in an ephemeral container with mounted workspace."""
        start_time = time.time()
        container = None
        try:
            # Mount host workspace to /app inside container
            abs_workspace = str(workspace_path.resolve())
            volumes = {abs_workspace: {"bind": "/app", "mode": "rw"}}

            logger.info(
                "Running in Docker [%s]: %s (mount: %s -> /app)",
                image_name,
                command,
                abs_workspace,
            )

            container = self._docker_client.containers.run(
                image=image_name,
                command=["sh", "-c", command],
                volumes=volumes,
                working_dir="/app",
                environment=env_vars or {},
                detach=True,
                network_mode="bridge",
            )

            # Wait for execution with timeout
            result = container.wait(timeout=timeout)
            exit_code = result.get("StatusCode", 1)

            stdout = container.logs(stdout=True, stderr=False).decode(
                "utf-8", errors="replace"
            )
            stderr = container.logs(stdout=False, stderr=True).decode(
                "utf-8", errors="replace"
            )

            return SandboxCommandResult(
                exit_code=exit_code,
                stdout=stdout,
                stderr=stderr,
                execution_time_seconds=round(time.time() - start_time, 2),
                timed_out=False,
                command=command,
            )

        except Exception as e:
            duration = round(time.time() - start_time, 2)
            is_timeout = "timeout" in str(e).lower() or duration >= timeout
            logger.error("Docker container run failed: %s", e)
            return SandboxCommandResult(
                exit_code=124 if is_timeout else 1,
                stdout="",
                stderr=f"Docker execution error: {str(e)}",
                execution_time_seconds=duration,
                timed_out=is_timeout,
                command=command,
            )
        finally:
            if container:
                try:
                    container.remove(force=True)
                except Exception:
                    pass

    def _run_in_subprocess(
        self,
        workspace_path: Path,
        command: str,
        timeout: int,
        env_vars: Optional[Dict[str, str]] = None,
    ) -> SandboxCommandResult:
        """Fallback local subprocess execution confined to workspace directory."""
        start_time = time.time()
        env = os.environ.copy()
        if env_vars:
            env.update(env_vars)

        logger.info("Executing in fallback subprocess (cwd=%s): %s", workspace_path, command)

        try:
            # Shell execution confined to workspace path
            proc = subprocess.run(
                command,
                cwd=str(workspace_path),
                shell=True,
                capture_output=True,
                text=True,
                timeout=timeout,
                env=env,
            )
            return SandboxCommandResult(
                exit_code=proc.returncode,
                stdout=proc.stdout,
                stderr=proc.stderr,
                execution_time_seconds=round(time.time() - start_time, 2),
                timed_out=False,
                command=command,
            )
        except subprocess.TimeoutExpired as te:
            return SandboxCommandResult(
                exit_code=124,
                stdout=te.stdout or "" if isinstance(te.stdout, str) else "",
                stderr=(te.stderr or "") + f"\nCommand timed out after {timeout} seconds.",
                execution_time_seconds=round(time.time() - start_time, 2),
                timed_out=True,
                command=command,
            )
        except Exception as e:
            return SandboxCommandResult(
                exit_code=1,
                stdout="",
                stderr=f"Subprocess execution failed: {str(e)}",
                execution_time_seconds=round(time.time() - start_time, 2),
                timed_out=False,
                command=command,
            )
