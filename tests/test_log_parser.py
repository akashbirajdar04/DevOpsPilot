"""Unit tests for LogParser (ANSI escape stripping and error window extraction)."""

import pytest
from app.services.log_parser import LogParser


def test_strip_ansi_sequences():
    """Verify ANSI color codes and terminal escapes are completely removed."""
    raw_terminal_output = (
        "\x1B[31mFAIL\x1B[39m \x1B[2mtests/\x1B[22m\x1B[1mapp.test.js\x1B[22m\r\n"
        "  ● Test suite failed to run\r\n"
        "\x1B[1m\x1B[31m    TypeError: Cannot read properties of undefined (reading 'process')\x1B[39m\x1B[22m\r\n"
        "\x1B[32mPASS\x1B[39m other.test.js"
    )

    clean = LogParser.strip_ansi(raw_terminal_output)

    assert "\x1B" not in clean
    assert "FAIL tests/app.test.js" in clean
    assert "TypeError: Cannot read properties of undefined (reading 'process')" in clean
    assert "PASS other.test.js" in clean


def test_extract_error_window_focuses_on_failure():
    """Ensure that in a large log file, the error window extracts the failure region."""
    # Generate 300 lines of noisy logs
    lines = [f"Step {i}: downloading package artifact..." for i in range(1, 200)]
    lines.append("npm ERR! code ELIFECYCLE")
    lines.append("npm ERR! errno 1")
    lines.append("npm ERR! auth-service@1.0.0 test: `jest` failed with exit code 1")
    lines.append("Process completed with exit code 1.")
    lines.extend([f"Cleanup line {i}..." for i in range(1, 50)])

    raw_log = "\n".join(lines)
    result = LogParser.parse_log(raw_log, max_lines=50)

    assert result.raw_line_count > 240
    assert len(result.extracted_window.splitlines()) <= 50
    assert "npm ERR! code ELIFECYCLE" in result.extracted_window
    assert "Process completed with exit code 1." in result.extracted_window
    assert len(result.detected_errors) > 0


def test_empty_log_handling():
    """Verify empty or whitespace-only logs do not cause crashes."""
    res = LogParser.parse_log("")
    assert res.raw_line_count == 0
    assert res.extracted_window == ""
    assert res.detected_errors == []


def test_detect_python_traceback():
    """Verify Python ModuleNotFoundError and Traceback are identified."""
    python_traceback = (
        "Traceback (most recent call last):\n"
        '  File "/app/main.py", line 12, in <module>\n'
        "    import missing_dependency\n"
        "ModuleNotFoundError: No module named 'missing_dependency'\n"
        "Process completed with exit code 1."
    )
    result = LogParser.parse_log(python_traceback, max_lines=100)
    assert "ModuleNotFoundError" in result.extracted_window
    assert any("ModuleNotFoundError" in err for err in result.detected_errors)
