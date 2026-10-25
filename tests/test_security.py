"""Unit tests for SecretScanner (Gitleaks / TruffleHog emulation)."""

import pytest
from app.services.security import SecretScanner


def test_safe_diff_passes():
    """Verify standard code patches without secrets pass cleanly."""
    safe_diff = """--- a/src/app.js
+++ b/src/app.js
@@ -10,3 +10,3 @@
-const port = 3000;
+const port = process.env.PORT || 8080;
+console.log("Starting server on port", port);
"""
    result = SecretScanner.scan_diff(safe_diff)
    assert result.passed is True
    assert len(result.detected_violations) == 0


def test_aws_access_key_blocked():
    """Verify AWS access key ID in patch is caught."""
    leaked_diff = """--- a/config.py
+++ b/config.py
@@ -1,2 +1,3 @@
+AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE"
+AWS_SECRET_KEY = "123456"
"""
    result = SecretScanner.scan_diff(leaked_diff)
    assert result.passed is False
    assert any("AWS Access Key ID" in v for v in result.detected_violations)


def test_github_token_blocked():
    """Verify GitHub personal access token in patch is caught."""
    leaked_diff = """--- a/.env
+++ b/.env
@@ -1 +1 @@
+GITHUB_TOKEN="ghp_1234567890abcdefghijklmnopqrstuvwx"
"""
    result = SecretScanner.scan_diff(leaked_diff)
    assert result.passed is False
    assert any("GitHub Classic Token" in v for v in result.detected_violations)


def test_secret_redaction():
    """Verify secret patterns are masked in redacted output."""
    raw_text = "Key: ghp_1234567890abcdefghijklmnopqrstuvwx and AKIAIOSFODNN7EXAMPLE"
    redacted = SecretScanner.redact_secrets(raw_text)
    assert "ghp_1234567890abcdefghijklmnopqrstuvwx" not in redacted
    assert "AKIAIOSFODNN7EXAMPLE" not in redacted
    assert "[REDACTED_SECRET]" in redacted
