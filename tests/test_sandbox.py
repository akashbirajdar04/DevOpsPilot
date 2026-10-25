"""Unit tests for WorkspaceManager and DockerSandbox."""

import shutil
import tempfile
from pathlib import Path
import git
import pytest

from app.services.sandbox import DockerSandbox, WorkspaceManager


@pytest.fixture
def temp_workspace_dir():
    """Create a temporary directory for workspace tests."""
    temp_dir = tempfile.mkdtemp(prefix="devopspilot_test_")
    yield Path(temp_dir)
    shutil.rmtree(temp_dir, ignore_errors=True)


def test_workspace_manager_branch_and_commit(temp_workspace_dir):
    """Test git workspace operations: create branch, apply changes, diff, commit."""
    wm = WorkspaceManager(base_dir=temp_workspace_dir)
    workspace = wm.get_workspace_path(run_id=999, job_id=888)
    workspace.mkdir(parents=True, exist_ok=True)

    # Initialize a local git repository
    repo = git.Repo.init(str(workspace))
    test_file = workspace / "index.js"
    test_file.write_text("console.log('original');\n", encoding="utf-8")
    repo.git.add("-A")
    repo.index.commit("Initial commit")

    # Create dynamic fix branch
    wm.create_fix_branch(workspace, "fix/ci-failure-888")
    assert repo.active_branch.name == "fix/ci-failure-888"

    # Make a modification
    test_file.write_text("console.log('repaired');\n", encoding="utf-8")

    # Check git diff
    diff = wm.get_git_diff(workspace)
    assert "-console.log('original');" in diff
    assert "+console.log('repaired');" in diff

    # Commit changes
    commit_sha = wm.commit_changes(workspace, "fix(ci): repair test failure")
    assert len(commit_sha) == 40
    assert repo.is_dirty() is False


def test_docker_sandbox_fallback_execution(temp_workspace_dir):
    """Test command execution in DockerSandbox (fallback process mode)."""
    sandbox = DockerSandbox()
    workspace = temp_workspace_dir / "app"
    workspace.mkdir(parents=True, exist_ok=True)

    # Run a simple python one-liner inside the workspace
    result = sandbox.execute_command(
        workspace_path=workspace,
        command='python -c "print(\'Sandbox alive\')"',
    )

    assert result.exit_code == 0
    assert "Sandbox alive" in result.stdout
    assert result.timed_out is False


def test_docker_sandbox_timeout(temp_workspace_dir):
    """Test timeout enforcement in sandbox."""
    sandbox = DockerSandbox()
    workspace = temp_workspace_dir / "app"
    workspace.mkdir(parents=True, exist_ok=True)

    # Command that sleeps longer than timeout
    result = sandbox.execute_command(
        workspace_path=workspace,
        command='python -c "import time; time.sleep(5)"',
        timeout_seconds=1,
    )

    assert result.timed_out is True
    assert result.exit_code == 124
    assert "timed out" in result.stderr.lower()
