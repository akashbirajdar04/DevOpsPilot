"""Pydantic schemas for webhooks, agent state, tools, sandbox, and pull requests."""

from enum import Enum
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field


class AgentStepEnum(str, Enum):
    """Execution states within the Agentic remediation finite state machine."""

    INGEST = "INGEST"
    DIAGNOSE = "DIAGNOSE"
    GENERATE_PATCH = "GENERATE_PATCH"
    EXECUTE_VALIDATION = "EXECUTE_VALIDATION"
    EVALUATE = "EVALUATE"
    CREATE_PR = "CREATE_PR"
    ABORT_NOTIFY = "ABORT_NOTIFY"
    COMPLETED = "COMPLETED"


# ==============================================================================
# GitHub Webhook Schemas
# ==============================================================================

class GitHubRepoOwner(BaseModel):
    login: str
    id: Optional[int] = None
    avatar_url: Optional[str] = None


class GitHubRepository(BaseModel):
    id: int
    name: str
    full_name: str
    private: bool = False
    html_url: str
    clone_url: str
    default_branch: str = "main"
    owner: GitHubRepoOwner


class GitHubWorkflowStep(BaseModel):
    name: str
    status: str
    conclusion: Optional[str] = None
    number: int


class GitHubWorkflowJob(BaseModel):
    id: int
    run_id: int
    workflow_name: Optional[str] = None
    head_branch: str
    head_sha: str
    status: str
    conclusion: Optional[str] = None
    created_at: str
    started_at: Optional[str] = None
    completed_at: Optional[str] = None
    html_url: str
    steps: Optional[List[GitHubWorkflowStep]] = []


class GitHubWebhookPayload(BaseModel):
    """Payload sent by GitHub Actions for workflow_job events."""

    action: str
    workflow_job: Optional[GitHubWorkflowJob] = None
    repository: GitHubRepository
    sender: Optional[Dict[str, Any]] = None


class WebhookResponse(BaseModel):
    """Standardized response from the webhook receiver endpoint."""

    status: str = Field(description="Processing status: accepted, ignored, error")
    message: str = Field(description="Explanation of action taken")
    job_id: Optional[int] = None
    repo: Optional[str] = None
    remediation_dispatched: bool = False


# ==============================================================================
# Sandbox & Tool Schemas
# ==============================================================================

class SandboxCommandRequest(BaseModel):
    command: str = Field(description="Shell command to run in container or sandbox")
    timeout_seconds: Optional[int] = 120
    working_subdir: Optional[str] = None
    env_vars: Optional[Dict[str, str]] = None


class SandboxCommandResult(BaseModel):
    exit_code: int = Field(description="Process exit code (0 = success)")
    stdout: str = Field(default="", description="Captured standard output")
    stderr: str = Field(default="", description="Captured standard error")
    execution_time_seconds: float = 0.0
    timed_out: bool = False
    command: str = ""


class ReadFileInput(BaseModel):
    file_path: str = Field(description="Relative path of file to read from repo root")


class WriteFileInput(BaseModel):
    file_path: str = Field(description="Relative path of file to write to")
    content: str = Field(description="Full replacement content for the file")


class ExecuteBuildInput(BaseModel):
    command: str = Field(
        description="Command to run in sandbox (e.g., 'npm test', 'pytest', 'mvn test')"
    )


class ListDirectoryInput(BaseModel):
    directory_path: str = Field(
        default=".", description="Relative path of directory to inspect"
    )


# ==============================================================================
# Log Parsing & Diagnosis Schemas
# ==============================================================================

class LogAnalysisResult(BaseModel):
    raw_line_count: int
    parsed_line_count: int
    extracted_window: str
    detected_errors: List[str] = []
    failure_step_name: Optional[str] = None


class SecretScanResult(BaseModel):
    passed: bool
    detected_violations: List[str] = []
    redacted_diff: Optional[str] = None


# ==============================================================================
# Agent Session & Remediation Results
# ==============================================================================

class RemediationResult(BaseModel):
    job_id: int
    run_id: int
    repo_full_name: str
    branch_name: str
    success: bool
    iterations_used: int
    pr_url: Optional[str] = None
    root_cause_summary: str = ""
    modified_files: List[str] = []
    error_message: Optional[str] = None
