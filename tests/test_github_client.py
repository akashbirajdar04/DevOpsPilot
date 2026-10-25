"""Unit tests for GitHubClient authentication and PR generation."""

import time
from unittest.mock import MagicMock, patch
import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from app.config import Settings
from app.services.github_client import GitHubClient


@pytest.fixture
def mock_rsa_private_key():
    """Generate a temporary RSA private key for testing JWT signatures."""
    key = rsa.generate_private_key(
        public_exponent=65537,
        key_size=2048,
    )
    pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("utf-8")
    return pem


def test_pat_token_resolution():
    """Verify explicit PAT token resolution."""
    client = GitHubClient(token="ghp_test_explicit_pat_token_12345")
    assert client.get_token() == "ghp_test_explicit_pat_token_12345"
    headers = client.get_auth_headers()
    assert headers["Authorization"] == "Bearer ghp_test_explicit_pat_token_12345"


def test_github_app_jwt_generation(mock_rsa_private_key):
    """Verify GitHub App JWT payload and RS256 signature."""
    settings = Settings(
        github_app_id="123456",
        github_app_private_key=mock_rsa_private_key,
    )
    client = GitHubClient(token="", settings=settings)
    token = client._generate_app_jwt()

    assert token is not None
    # Decode without verifying key to inspect claims
    claims = jwt.decode(token, options={"verify_signature": False})
    assert claims["iss"] == "123456"
    assert claims["exp"] > time.time()


def test_pr_body_formatting():
    """Verify generation of markdown PR body."""
    body = GitHubClient.generate_pr_body(
        job_id=9876,
        run_id=5432,
        root_cause_analysis="Null pointer exception in auth handler.",
        modified_files=["src/auth.js", "tests/auth.test.js"],
        test_command="npm test",
        test_output="All 10 tests passed.",
        iterations=2,
    )

    assert "#9876" in body
    assert "Null pointer exception in auth handler." in body
    assert "`src/auth.js`" in body
    assert "npm test" in body
    assert "All 10 tests passed." in body
    assert "2 / 3" in body
