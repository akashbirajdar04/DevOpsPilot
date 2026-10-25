"""Log ingestion, ANSI escape code stripping, and error boundary window slicing."""

import re
from typing import List, Tuple
from app.models.schema import LogAnalysisResult

# Regex matching ANSI escape sequences (colors, cursor control, device attributes)
ANSI_ESCAPE_REGEX = re.compile(r"\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])")

# Common CI error indicators across Node.js, Python, Java, Go, Rust, and GitHub Actions
ERROR_KEYWORDS = [
    re.compile(r"\bERR!\b", re.IGNORECASE),
    re.compile(r"\bFAIL\b|\bFAILED\b", re.IGNORECASE),
    re.compile(r"\bFailure\b", re.IGNORECASE),
    re.compile(r"\bAssertionError\b", re.IGNORECASE),
    re.compile(r"\bModuleNotFoundError\b", re.IGNORECASE),
    re.compile(r"\bSyntaxError\b", re.IGNORECASE),
    re.compile(r"\bTypeError\b", re.IGNORECASE),
    re.compile(r"\bReferenceError\b", re.IGNORECASE),
    re.compile(r"\bTraceback \(most recent call last\):", re.IGNORECASE),
    re.compile(r"\bProcess completed with exit code [1-9]\d*", re.IGNORECASE),
    re.compile(r"\bExit code [1-9]\d*", re.IGNORECASE),
    re.compile(r"\bBUILD FAILED\b", re.IGNORECASE),
    re.compile(r"\bCompilation failed\b", re.IGNORECASE),
    re.compile(r"\bError:\b", re.IGNORECASE),
]


class LogParser:
    """Parses and strips raw CI log files into compact, relevant diagnostic snippets."""

    @staticmethod
    def strip_ansi(raw_text: str) -> str:
        """Strip ANSI terminal escape codes from the provided text."""
        if not raw_text:
            return ""
        # Remove ANSI sequences
        clean = ANSI_ESCAPE_REGEX.sub("", raw_text)
        # Normalize Windows carriage returns and trailing progress bar overwrites
        clean = clean.replace("\r\n", "\n").replace("\r", "\n")
        return clean

    @classmethod
    def find_error_line_indices(cls, lines: List[str]) -> List[int]:
        """Return the 0-indexed line numbers where error markers occur."""
        indices = []
        for idx, line in enumerate(lines):
            for pattern in ERROR_KEYWORDS:
                if pattern.search(line):
                    indices.append(idx)
                    break
        return indices

    @classmethod
    def extract_error_window(
        cls, lines: List[str], max_lines: int = 150
    ) -> Tuple[str, List[str]]:
        """
        Extract a focused window of lines around the failure points.

        If errors are detected, centers or captures context around the primary/last failure.
        If no error keywords match, returns the trailing `max_lines` from the log.
        """
        total_lines = len(lines)
        if total_lines == 0:
            return "", []

        if total_lines <= max_lines:
            error_snippets = [
                lines[i]
                for i in cls.find_error_line_indices(lines)
            ]
            return "\n".join(lines), error_snippets

        error_indices = cls.find_error_line_indices(lines)

        if not error_indices:
            # Fallback to the tail of the log if no known keywords matched
            start_idx = max(0, total_lines - max_lines)
            return "\n".join(lines[start_idx:]), []

        # Find the last significant failure cluster (usually where the run failed)
        last_error_idx = error_indices[-1]

        # Allocate 70% before the error for context/traceback and 30% after
        before_context = int(max_lines * 0.70)
        after_context = max_lines - before_context

        start_idx = max(0, last_error_idx - before_context)
        end_idx = min(total_lines, last_error_idx + after_context)

        # Adjust window if start or end bounds were truncated
        if end_idx - start_idx < max_lines:
            start_idx = max(0, end_idx - max_lines)

        selected_lines = lines[start_idx:end_idx]
        detected_snippets = [
            lines[i]
            for i in error_indices
            if start_idx <= i < end_idx
        ]

        return "\n".join(selected_lines), detected_snippets

    @classmethod
    def parse_log(cls, raw_log: str, max_lines: int = 150) -> LogAnalysisResult:
        """Strip ANSI codes and extract the focused diagnostic window."""
        cleaned_text = cls.strip_ansi(raw_log)
        lines = [line.strip() for line in cleaned_text.splitlines() if line.strip()]

        extracted_window, detected_snippets = cls.extract_error_window(
            lines, max_lines=max_lines
        )

        return LogAnalysisResult(
            raw_line_count=len(raw_log.splitlines()),
            parsed_line_count=len(lines),
            extracted_window=extracted_window,
            detected_errors=detected_snippets[:10],  # Keep top 10 unique snippets
        )
