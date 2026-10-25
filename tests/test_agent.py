"""Unit tests for Agent WorkspaceTools and security sandboxing."""

import json
import shutil
import tempfile
from pathlib import Path
import pytest

from app.agent.tools import WorkspaceTools


@pytest.fixture
def temp_workspace():
    """Create a temporary workspace directory."""
    temp_dir = tempfile.mkdtemp(prefix="agent_tools_test_")
    ws_path = Path(temp_dir)
    # Create sample files
    (ws_path / "src").mkdir(parents=True, exist_ok=True)
    (ws_path / "src" / "index.js").write_text("const msg = 'hello world';", encoding="utf-8")
    (ws_path / "package.json").write_text('{"name": "sample", "version": "1.0.0"}', encoding="utf-8")
    yield ws_path
    shutil.rmtree(temp_dir, ignore_errors=True)


def test_list_directory(temp_workspace):
    """Test listing directory contents."""
    tools = WorkspaceTools(workspace_path=temp_workspace)
    listing = tools.list_directory(".")
    assert "package.json" in listing
    assert "src" in listing


def test_read_and_write_file(temp_workspace):
    """Test reading and writing workspace files."""
    tools = WorkspaceTools(workspace_path=temp_workspace)

    # Read existing file
    content = tools.read_workspace_file("src/index.js")
    assert "hello world" in content

    # Write new file
    res = tools.write_workspace_file("src/utils.js", "export function add(a, b) { return a + b; }")
    assert "Successfully wrote" in res
    assert "src/utils.js" in tools.modified_files

    # Verify written content
    assert tools.read_workspace_file("src/utils.js") == "export function add(a, b) { return a + b; }"


def test_patch_file(temp_workspace):
    """Test patching exact code blocks in files."""
    tools = WorkspaceTools(workspace_path=temp_workspace)

    res = tools.patch_workspace_file(
        "src/index.js",
        old_str="'hello world'",
        new_str="'hello devopspilot'",
    )
    assert "Successfully replaced" in res
    assert "src/index.js" in tools.modified_files

    updated = tools.read_workspace_file("src/index.js")
    assert "'hello devopspilot'" in updated


def test_path_traversal_blocked(temp_workspace):
    """Verify attempts to read or write outside workspace root are blocked."""
    tools = WorkspaceTools(workspace_path=temp_workspace)

    # Attempt directory traversal
    with pytest.raises(ValueError, match="Security violation"):
        tools._resolve_safe_path("../../secret.txt")

    # Read outside workspace
    read_err = tools.read_workspace_file("../outside.txt")
    assert "Error" in read_err


def test_execute_sandbox_command(temp_workspace):
    """Test executing a command through WorkspaceTools."""
    tools = WorkspaceTools(workspace_path=temp_workspace)
    output_json = tools.execute_sandbox_command('python -c "print(\'Agent tool test passed\')"')
    data = json.loads(output_json)

    assert data["exit_code"] == 0
    assert "Agent tool test passed" in data["stdout"]
    assert tools.last_test_result is not None
    assert tools.last_test_result.exit_code == 0


def test_specification_tool_aliases(temp_workspace):
    """Verify specification aliases: read_repo_file, apply_code_patch, run_sandbox_command."""
    tools = WorkspaceTools(workspace_path=temp_workspace)

    # 1. read_repo_file
    content = tools.read_repo_file("src/index.js")
    assert "hello world" in content

    # 2. apply_code_patch
    patch_res = tools.apply_code_patch("src/index.js", "hello world", "hello prompt specs")
    assert "Successfully replaced" in patch_res
    assert "hello prompt specs" in tools.read_repo_file("src/index.js")

    # 3. run_sandbox_command
    sandbox_res = tools.run_sandbox_command('python -c "print(\'Alias execution success\')"')
    data = json.loads(sandbox_res)
    assert data["exit_code"] == 0
    assert "Alias execution success" in data["stdout"]
