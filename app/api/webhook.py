"""GitHub Webhook Receiver Endpoint with HMAC verification and recursive loop guards."""

import hashlib
import hmac
import json
import logging
from typing import Optional
from fastapi import APIRouter, BackgroundTasks, Header, HTTPException, Request, status

from app.agent.core import AgenticLoopController
from app.config import get_settings
from app.models.schema import GitHubWebhookPayload, WebhookResponse
from app.services.github_client import GitHubClient
from app.services.log_parser import LogParser

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/webhook", tags=["Webhook"])


def verify_github_signature(
    payload_bytes: bytes,
    signature_header: Optional[str],
    secret: str,
) -> bool:
    """
    Verify GitHub HMAC-SHA256 signature from the X-Hub-Signature-256 header.
    Uses hmac.compare_digest to defend against timing attacks.
    """
    if not secret:
        # If no secret is configured in environment, log warning and bypass in local dev
        logger.warning("GITHUB_WEBHOOK_SECRET is not configured; skipping HMAC verification.")
        return True

    if not signature_header or not signature_header.startswith("sha256="):
        logger.warning("Missing or malformed X-Hub-Signature-256 header.")
        return False

    expected_sig = signature_header.split("sha256=", 1)[1]
    mac = hmac.new(secret.encode("utf-8"), msg=payload_bytes, digestmod=hashlib.sha256)
    computed_sig = mac.hexdigest()

    return hmac.compare_digest(computed_sig, expected_sig)


async def process_failed_job_background(
    run_id: int,
    job_id: int,
    repo_full_name: str,
    clone_url: str,
    head_branch: str,
    step_name: str,
):
    """Background task executed when a valid workflow_job failure is received."""
    logger.info(
        "Starting background remediation task for Job #%d (Run #%d) in %s on branch %s",
        job_id,
        run_id,
        repo_full_name,
        head_branch,
    )

    github_client = GitHubClient()
    raw_log = ""
    try:
        raw_log = await github_client.fetch_job_logs(repo_full_name, job_id)
    except Exception as e:
        logger.error("Failed to download logs for job %d: %s", job_id, e)

    # Clean and slice log window
    parsed_log = LogParser.parse_log(raw_log or "Error: workflow_job failure without downloaded logs.")
    logger.info(
        "Processed logs for job %d: extracted %d relevant lines around errors",
        job_id,
        len(parsed_log.extracted_window.splitlines()),
    )

    controller = AgenticLoopController(github_client=github_client)
    result = await controller.run_remediation(
        run_id=run_id,
        job_id=job_id,
        repo_full_name=repo_full_name,
        clone_url=clone_url,
        head_branch=head_branch,
        error_log_window=parsed_log.extracted_window,
        step_name=step_name,
    )

    if result.success:
        logger.info(
            "Remediation succeeded for job %d! PR created: %s",
            job_id,
            result.pr_url or "Local branch committed",
        )
    else:
        logger.warning(
            "Remediation could not resolve failure for job %d: %s",
            job_id,
            result.error_message,
        )


@router.post("/github", response_model=WebhookResponse, status_code=status.HTTP_202_ACCEPTED)
async def github_webhook_endpoint(
    request: Request,
    background_tasks: BackgroundTasks,
    x_hub_signature_256: Optional[str] = Header(None, alias="X-Hub-Signature-256"),
    x_github_event: Optional[str] = Header(None, alias="X-GitHub-Event"),
):
    """
    Ingest GitHub Actions Webhooks.
    1. Authenticates HMAC-SHA256 signature
    2. Filters for workflow_job.completed with conclusion == failure
    3. Blocks recursive runs on fix/ci-* branches
    4. Dispatches remediation task to background worker
    """
    settings = get_settings()
    raw_body = await request.body()

    # 1. HMAC Signature Verification
    if settings.github_webhook_secret:
        if not verify_github_signature(raw_body, x_hub_signature_256, settings.github_webhook_secret):
            logger.warning("Unauthorized webhook: HMAC signature verification failed.")
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid or missing X-Hub-Signature-256 HMAC signature.",
            )

    # 2. Filter GitHub Event Type
    if x_github_event != "workflow_job":
        logger.debug("Ignored event type: %s", x_github_event)
        return WebhookResponse(
            status="ignored",
            message=f"Event '{x_github_event}' is not 'workflow_job'.",
            remediation_dispatched=False,
        )

    # Parse JSON payload
    try:
        data = json.loads(raw_body.decode("utf-8"))
        payload = GitHubWebhookPayload(**data)
    except Exception as e:
        logger.error("Failed to parse GitHub webhook JSON: %s", e)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Malformed webhook JSON payload: {str(e)}",
        )

    job = payload.workflow_job
    if not job:
        return WebhookResponse(
            status="ignored",
            message="No workflow_job object present in payload.",
            remediation_dispatched=False,
        )

    # 3. Filter Action and Conclusion
    if payload.action != "completed" or job.conclusion != "failure":
        logger.debug(
            "Skipping job %d: action='%s', conclusion='%s'",
            job.id,
            payload.action,
            job.conclusion,
        )
        return WebhookResponse(
            status="ignored",
            message=f"Ignored non-failure event (action={payload.action}, conclusion={job.conclusion}).",
            job_id=job.id,
            repo=payload.repository.full_name,
            remediation_dispatched=False,
        )

    # 4. Anti-Infinite Recursion Guard
    head_branch = job.head_branch or ""
    if head_branch.startswith("fix/ci-") or head_branch.startswith("fix/remediation-"):
        logger.info(
            "Skipping job %d on branch '%s' to prevent infinite remediation loop.",
            job.id,
            head_branch,
        )
        return WebhookResponse(
            status="ignored",
            message=f"Skipped: Event originates from automated remediation branch '{head_branch}'.",
            job_id=job.id,
            repo=payload.repository.full_name,
            remediation_dispatched=False,
        )

    # Identify failing step if present
    step_name = "Build / Test Step"
    if job.steps:
        for step in job.steps:
            if step.conclusion == "failure":
                step_name = step.name
                break

    # 5. Dispatch background remediation
    background_tasks.add_task(
        process_failed_job_background,
        run_id=job.run_id,
        job_id=job.id,
        repo_full_name=payload.repository.full_name,
        clone_url=payload.repository.clone_url,
        head_branch=head_branch,
        step_name=step_name,
    )

    logger.info(
        "Accepted failed job %d from %s (branch: %s). Dispatched remediation.",
        job.id,
        payload.repository.full_name,
        head_branch,
    )

    return WebhookResponse(
        status="accepted",
        message="Failure event accepted. Self-healing remediation loop dispatched.",
        job_id=job.id,
        repo=payload.repository.full_name,
        remediation_dispatched=True,
    )
