"""Pre-commit secret scanning and redaction engine (Gitleaks CLI & regex heuristics)."""

import json
import logging
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Dict, List, Optional
from app.models.schema import SecretScanResult

logger = logging.getLogger(__name__)

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
    """Scans code diffs and workspaces to prevent secret leakage in automated remediation PRs."""

    @classmethod
    def is_gitleaks_available(cls) -> bool:
        """Check if Gitleaks CLI binary is installed and reachable in system PATH."""
        return shutil.which("gitleaks") is not None

    @classmethod
    def scan_with_gitleaks_cli(cls, diff_content: str) -> Optional[List[str]]:
        """
        Run official Gitleaks CLI against the patch stream if binary is installed.
        Returns list of detected violation descriptions, or None if CLI failed/unavailable.
        """
        if not cls.is_gitleaks_available() or not diff_content.strip():
            return None

        try:
            with tempfile.NamedTemporaryFile("w+", suffix=".json", delete=False) as report_file:
                report_path = report_file.name

            proc = subprocess.run(
                ["gitleaks", "detect", "--no-git", "--pipe", f"--report-path={report_path}"],
                input=diff_content,
                text=True,
                capture_output=True,
                timeout=15,
            )

            violations: List[str] = []
            report = Path(report_path)
            if report.exists() and report.stat().st_size > 0:
                try:
                    findings = json.loads(report.read_text(encoding="utf-8"))
                    for f in findings:
                        rule = f.get("RuleID") or f.get("Description") or "Secret"
                        file_name = f.get("File", "patch")
                        violations.append(f"Gitleaks: {rule} detected in {file_name}")
                except Exception:
                    pass
                report.unlink(missing_ok=True)

            # Exit code 1 in gitleaks means leaks were detected
            if proc.returncode != 0 and not violations:
                violations.append("Gitleaks detected secret patterns in diff stream.")

            return violations

        except Exception as e:
            logger.warning("Gitleaks CLI execution encountered error: %s", e)
            return None

    @classmethod
    def scan_diff(cls, diff_content: str) -> SecretScanResult:
        """
        Scans added lines in a patch or full file content for potential secrets.
        Uses Gitleaks CLI if available, combined with high-precision regex signatures.
        """
        if not diff_content:
            return SecretScanResult(passed=True, detected_violations=[])

        violations: List[str] = []

        # 1. Try Gitleaks CLI if present
        cli_violations = cls.scan_with_gitleaks_cli(diff_content)
        if cli_violations is not None:
            violations.extend(cli_violations)

        # 2. Built-in Regex scanner pass
        lines = diff_content.splitlines()
        for line_num, line in enumerate(lines, 1):
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
