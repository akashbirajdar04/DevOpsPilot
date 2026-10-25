"""CLI entrypoint for running DevOpsPilot directly inside GitHub Actions runner (Zero-Server Mode)."""

import asyncio
import logging
import os
import sys
from pathlib import Path

from app.agent.core import AgenticLoopController
from app.config import get_settings
from app.services.github_client import GitHubClient
from app.services.log_parser import LogParser

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("DevOpsPilot.ActionRunner")


async def main():
    settings = get_settings()

    repo_full_name = os.environ.get("GITHUB_REPOSITORY")
    ref_name = os.environ.get("GITHUB_REF_NAME", "main")
    run_id_str = os.environ.get("GITHUB_RUN_ID", "0")
    job_name = os.environ.get("GITHUB_JOB", "ci-build")

    if not repo_full_name:
        logger.error("Missing GITHUB_REPOSITORY environment variable.")
        sys.exit(1)

    # Check loop guard
    if ref_name.startswith("fix/ci-") or ref_name.startswith("fix/remediation-"):
        logger.info("Skipping execution on automated remediation branch: %s", ref_name)
        sys.exit(0)

    run_id = int(run_id_str)
    job_id = run_id  # In action runner context, use run_id as identifier

    logger.info("DevOpsPilot Action Runner started for %s (branch: %s, run: %d)", repo_full_name, ref_name, run_id)

    github_client = GitHubClient()
    raw_logs = ""
    try:
        raw_logs = await github_client.fetch_job_logs(repo_full_name, job_id)
    except Exception as e:
        logger.warning("Could not fetch remote job logs: %s. Reading local fallback.", e)

    parsed_log = LogParser.parse_log(raw_logs or f"CI Failure detected in step: {job_name}")

    clone_url = f"https://github.com/{repo_full_name}.git"

    controller = AgenticLoopController(github_client=github_client)
    result = await controller.run_remediation(
        run_id=run_id,
        job_id=job_id,
        repo_full_name=repo_full_name,
        clone_url=clone_url,
        head_branch=ref_name,
        error_log_window=parsed_log.extracted_window,
        step_name=job_name,
    )

    if result.success:
        logger.info("✅ Remediation successful! PR opened: %s", result.pr_url or "Committed")
        sys.exit(0)
    else:
        logger.error("❌ Remediation failed: %s", result.error_message)
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
