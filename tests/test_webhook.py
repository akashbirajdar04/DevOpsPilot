"""Unit tests for GitHub Webhook endpoint, HMAC authentication, and guard rules."""

import hashlib
import hmac
import json
import pytest
from fastapi.testclient import TestClient

from app.api.webhook import verify_github_signature
from app.config import get_settings
from app.main import app

client = TestClient(app)


def compute_signature(payload_bytes: bytes, secret: str) -> str:
    """Helper to compute valid GitHub X-Hub-Signature-256 header."""
    mac = hmac.new(secret.encode("utf-8"), msg=payload_bytes, digestmod=hashlib.sha256)
    return f"sha256={mac.hexdigest()}"


def test_hmac_signature_verification():
    """Verify correct HMAC matching and tampering rejection."""
    secret = "super-secret-ci-key"
    payload = b'{"test": "payload"}'
    valid_sig = compute_signature(payload, secret)

    assert verify_github_signature(payload, valid_sig, secret) is True
    assert verify_github_signature(payload, "sha256=invalidhex123", secret) is False
    assert verify_github_signature(payload, None, secret) is False


def test_webhook_ignores_non_workflow_job_event():
    """Webhook should ignore push or PR events."""
    payload = {"zen": "Keep it logically awesome."}
    response = client.post(
        "/api/v1/webhook/github",
        json=payload,
        headers={"X-GitHub-Event": "ping"},
    )
    assert response.status_code == 202
    data = response.json()
    assert data["status"] == "ignored"
    assert "workflow_job" in data["message"]
    assert data["remediation_dispatched"] is False


def test_webhook_ignores_successful_job():
    """Webhook should ignore successful jobs."""
    payload = {
        "action": "completed",
        "workflow_job": {
            "id": 1001,
            "run_id": 5001,
            "head_branch": "main",
            "head_sha": "abc1234",
            "status": "completed",
            "conclusion": "success",
            "created_at": "2026-10-25T10:00:00Z",
            "html_url": "https://github.com/org/repo/runs/1001",
        },
        "repository": {
            "id": 1,
            "name": "repo",
            "full_name": "org/repo",
            "private": False,
            "html_url": "https://github.com/org/repo",
            "clone_url": "https://github.com/org/repo.git",
            "owner": {"login": "org"},
        },
    }
    response = client.post(
        "/api/v1/webhook/github",
        json=payload,
        headers={"X-GitHub-Event": "workflow_job"},
    )
    assert response.status_code == 202
    data = response.json()
    assert data["status"] == "ignored"
    assert data["remediation_dispatched"] is False


def test_webhook_blocks_recursive_loop_on_fix_branch():
    """Ensure branches starting with fix/ci- are discarded to stop infinite loops."""
    payload = {
        "action": "completed",
        "workflow_job": {
            "id": 1002,
            "run_id": 5002,
            "head_branch": "fix/ci-failure-999",
            "head_sha": "def5678",
            "status": "completed",
            "conclusion": "failure",
            "created_at": "2026-10-25T10:05:00Z",
            "html_url": "https://github.com/org/repo/runs/1002",
        },
        "repository": {
            "id": 1,
            "name": "repo",
            "full_name": "org/repo",
            "private": False,
            "html_url": "https://github.com/org/repo",
            "clone_url": "https://github.com/org/repo.git",
            "owner": {"login": "org"},
        },
    }
    response = client.post(
        "/api/v1/webhook/github",
        json=payload,
        headers={"X-GitHub-Event": "workflow_job"},
    )
    assert response.status_code == 202
    data = response.json()
    assert data["status"] == "ignored"
    assert "automated remediation branch" in data["message"]
    assert data["remediation_dispatched"] is False


def test_webhook_accepts_valid_failed_job():
    """A genuine CI failure on a feature branch should be accepted and dispatched."""
    payload = {
        "action": "completed",
        "workflow_job": {
            "id": 1003,
            "run_id": 5003,
            "head_branch": "feature/login-jwt",
            "head_sha": "ghi9012",
            "status": "completed",
            "conclusion": "failure",
            "created_at": "2026-10-25T10:10:00Z",
            "html_url": "https://github.com/org/repo/runs/1003",
            "steps": [
                {"name": "Checkout", "status": "completed", "conclusion": "success", "number": 1},
                {"name": "Run Jest Tests", "status": "completed", "conclusion": "failure", "number": 2},
            ],
        },
        "repository": {
            "id": 1,
            "name": "repo",
            "full_name": "org/repo",
            "private": False,
            "html_url": "https://github.com/org/repo",
            "clone_url": "https://github.com/org/repo.git",
            "owner": {"login": "org"},
        },
    }
    response = client.post(
        "/api/v1/webhook/github",
        json=payload,
        headers={"X-GitHub-Event": "workflow_job"},
    )
    assert response.status_code == 202
    data = response.json()
    assert data["status"] == "accepted"
    assert data["job_id"] == 1003
    assert data["remediation_dispatched"] is True
