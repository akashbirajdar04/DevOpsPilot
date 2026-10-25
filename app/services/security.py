"""Pre-commit secret scanning and redaction engine for generated patches."""

import re
from typing import Dict, List
from app.models.schema import SecretScanResult

# Common high-risk secret signatures (Gitleaks / TruffleHog patterns)
SECRET_PATTERNS: Dict[str, re.Pattern] = {
    "AWS Access Key ID": re.compile(r"\b(AKIA|ABIA|ACCA|ASIA)[0-9A-Z]{16}\b"),
    "AWS Secret Key": re.compile(
        r"(?i)(?:aws_secret_access_key|aws_secret_key)\s*[:=]\s*['\"]([A-Za-z0-9/\+=]{40})['\"]"
    ),
    "GitHub Classic Token": re.compile(r"\bghp_[0-9a-zA-Z]{20,40}\b"),
    "GitHub Fine-Grained Token": re.compile(r"\bgithub_pat_[0-9a-zA-Z_]{70,90}\b"),
    "GitHub OAuth / App Token": re.compile(r"\b(gho|ghu|ghs|ghr)_[0-9a-zA-Z]{20,40}\b"),
    "Google API Key": re.compile(r"\bAIza[0-9A-Za-z\-_]{35}\b"),
    "Slack Token": re.compile(r"\bxox[baprs]-[0-9a-zA-Z]{10,48}\b"),
    "Private Key Header": re.compile(
        r"-----BEGIN (?:RSA|EC|DSA|OPENSSH|PGP)? PRIVATE KEY-----"
    ),
    "Generic High-Entropy Password/Secret": re.compile(
        r"(?i)\b(?:password|passwd|secret_key|api_secret|client_secret)\s*[:=]\s*['\"]([^'\"]{10,})['\"]"
    ),
    "Bearer Authorization Header": re.compile(
        r"(?i)bearer\s+[A-Za-z0-9\-_=]+\.[A-Za-z0-9\-_=]+\.?[A-Za-z0-9\-_=]*"
    ),
}


class SecretScanner:
    """Scans code diffs and files to prevent secret leakage in automated remediation PRs."""

    @classmethod
    def scan_diff(cls, diff_content: str) -> SecretScanResult:
        """
        Scans added lines in a patch or full file content for potential secrets.
        Returns SecretScanResult indicating if the patch is safe.
        """
        if not diff_content:
            return SecretScanResult(passed=True, detected_violations=[])

        violations: List[str] = []
        lines = diff_content.splitlines()

        for line_num, line in enumerate(lines, 1):
            # If scanning a unified diff, only check lines being added (+)
            # Skip diff metadata lines like +++ or ---
            is_addition = line.startswith("+") and not line.startswith("+++")
            content_to_check = line[1:] if is_addition else line

            for secret_name, pattern in SECRET_PATTERNS.items():
                if pattern.search(content_to_check):
                    violations.append(
                        f"Line {line_num}: Detected potential {secret_name}"
                    )

        passed = len(violations) == 0
        return SecretScanResult(
            passed=passed,
            detected_violations=violations,
            redacted_diff=cls.redact_secrets(diff_content) if not passed else diff_content,
        )

    @classmethod
    def redact_secrets(cls, text: str) -> str:
        """Replace detected secrets with [REDACTED_SECRET]."""
        redacted = text
        for _, pattern in SECRET_PATTERNS.items():
            redacted = pattern.sub("[REDACTED_SECRET]", redacted)
        return redacted
