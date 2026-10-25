"""End-to-End Simulation Test for DevOpsPilot self-healing workflow."""

import json
import shutil
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch
import git
import pytest

from app.agent.core import AgenticLoopController
from app.services.sandbox import DockerSandbox, WorkspaceManager


@pytest.fixture
def test_repo_env():
    """Sets up a mock source repo with a failing test and an isolated workspace manager."""
    temp_dir = tempfile.mkdtemp(prefix="devopspilot_e2e_")
    base_path = Path(temp_dir)

    origin_repo_path = base_path / "origin_repo"
    origin_repo_path.mkdir(parents=True, exist_ok=True)

    # Initialize a source repository
    repo = git.Repo.init(str(origin_repo_path))

    # Create package files with an intentional bug
    (origin_repo_path / "math_utils.py").write_text(
        "def multiply(a, b):\n    # Bug: returns addition instead of multiplication\n    return a + b\n",
        encoding="utf-8",
    )
    (origin_repo_path / "test_math.py").write_text(
        "from math_utils import multiply\n\n"
        "def test_multiply():\n"
        "    assert multiply(3, 4) == 12, 'Expected 3 * 4 to equal 12'\n\n"
        "if __name__ == '__main__':\n"
        "    test_multiply()\n"
        "    print('ALL_TESTS_PASSED')\n",
        encoding="utf-8",
    )

    repo.git.add("-A")
    repo.index.commit("Initial failing commit")

    workspaces_dir = base_path / "workspaces"
    workspaces_dir.mkdir(parents=True, exist_ok=True)

    wm = WorkspaceManager(base_dir=workspaces_dir)
    sandbox = DockerSandbox()

    yield {
        "base_path": base_path,
        "origin_repo_path": origin_repo_path,
        "wm": wm,
        "sandbox": sandbox,
    }

    shutil.rmtree(temp_dir, ignore_errors=True)


@pytest.mark.asyncio
async def test_end_to_end_remediation_cycle(test_repo_env):
    """
    Test the full remediation cycle:
    1. Workspace isolation & branch creation
    2. Simulated agent diagnosing and fixing the bug
    3. Sandbox executing verification test
    4. Secret scan passing
    5. Git commit creation and PR body formulation
    """
    wm: WorkspaceManager = test_repo_env["wm"]
    sandbox: DockerSandbox = test_repo_env["sandbox"]
    origin_path = test_repo_env["origin_repo_path"]

    mock_gh_client = MagicMock()
    mock_gh_client.fetch_job_logs = AsyncMock(
        return_value="AssertionError: Expected 3 * 4 to equal 12\nProcess completed with exit code 1."
    )
    mock_gh_client.create_pull_request.return_value = {
        "pr_number": 42,
        "html_url": "https://github.com/test-org/test-repo/pull/42",
        "state": "open",
    }

    controller = AgenticLoopController(
        workspace_manager=wm,
        docker_sandbox=sandbox,
        github_client=mock_gh_client,
    )

    # Mock the LLM agent call to simulate Gemini 2.5 Flash fixing the bug
    async def mock_agent_loop(run_id, job_id, repo_full_name, head_branch, step_name, error_log_window, tools):
        # 1. Inspect file
        content = tools.read_workspace_file("math_utils.py")
        assert "return a + b" in content

        # 2. Patch file
        tools.patch_workspace_file("math_utils.py", "return a + b", "return a * b")

        # 3. Execute sandbox validation
        cmd_result_json = tools.execute_sandbox_command("python test_math.py")
        res = json.loads(cmd_result_json)
        assert res["exit_code"] == 0
        assert "ALL_TESTS_PASSED" in res["stdout"]

        return True, 1, "Fixed multiplication logic in math_utils.py"

    with patch.object(controller, "_execute_agent_loop", side_effect=mock_agent_loop):
        result = await controller.run_remediation(
            run_id=101,
            job_id=202,
            repo_full_name="test-org/test-repo",
            clone_url=str(origin_path),
            head_branch="master",
            error_log_window="AssertionError: Expected 3 * 4 to equal 12",
            step_name="Run Pytest",
        )

        assert result.success is True
        assert result.job_id == 202
        assert result.branch_name == "fix/ci-failure-202"
        assert result.iterations_used == 1
        assert "math_utils.py" in result.modified_files
        assert "Fixed multiplication logic" in result.root_cause_summary
