"""DevOpsPilot: Self-Healing CI/CD Agent FastAPI Application Entrypoint."""

from contextlib import asynccontextmanager
import logging
import sys
import time
from fastapi import FastAPI, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.webhook import router as webhook_router
from app.config import get_settings
from app.services.sandbox import DockerSandbox

settings = get_settings()

# Configure structured logging
logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s [%(levelname)s] [%(name)s]: %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
    ],
)
logger = logging.getLogger("DevOpsPilot")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan context for startup validation and cleanup."""
    logger.info("Initializing DevOpsPilot CI/CD Self-Healing Agent...")
    logger.info("Environment: %s | Port: %d", settings.environment, settings.port)
    logger.info("LLM Model configured: %s", settings.gemini_model)

    # Check Docker Sandbox availability
    sandbox = DockerSandbox()
    if sandbox.is_docker_available:
        logger.info("Docker daemon is active. Sandboxing will run in container image '%s'.", settings.docker_sandbox_image)
    else:
        logger.warning("Docker daemon not reachable. Sandboxing will use isolated host subprocess mode.")

    if not settings.github_webhook_secret:
        logger.warning("GITHUB_WEBHOOK_SECRET is not configured! Webhook signature check will be bypassed.")
    if not settings.github_token:
        logger.warning("GITHUB_TOKEN is not configured! Automated PR creation and log fetching will be simulated.")

    yield

    logger.info("DevOpsPilot service shutting down...")


app = FastAPI(
    title="DevOpsPilot",
    description="Autonomous self-healing CI/CD remediation agent powered by Gemini 2.5 Flash and Docker Sandboxing.",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS Middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def log_requests(request: Request, call_next):
    """Middleware to measure response latency and log requests."""
    start_time = time.time()
    response = await call_next(request)
    duration_ms = round((time.time() - start_time) * 1000, 2)
    logger.info(
        "%s %s -> HTTP %d (%s ms)",
        request.method,
        request.url.path,
        response.status_code,
        duration_ms,
    )
    return response


# Global Exception Handlers
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    """Catch-all unhandled exception handler returning structured error JSON."""
    logger.exception("Unhandled server exception: %s", exc)
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={
            "error": "InternalServerError",
            "message": "An unexpected error occurred processing your request.",
            "detail": str(exc) if settings.environment == "development" else None,
        },
    )


# Health Check & Root Endpoints
@app.get("/", tags=["Health"])
async def root():
    """Service metadata and readiness check."""
    return {
        "service": "DevOpsPilot",
        "description": "Autonomous Self-Healing CI/CD Remediation Agent",
        "version": "0.1.0",
        "status": "online",
    }


@app.get("/health", tags=["Health"])
async def health_check():
    """Detailed health check endpoint assessing runtime status."""
    sandbox = DockerSandbox()
    return {
        "status": "healthy",
        "environment": settings.environment,
        "docker_available": sandbox.is_docker_available,
        "github_token_configured": bool(settings.github_token),
        "webhook_secret_configured": bool(settings.github_webhook_secret),
        "gemini_api_key_configured": bool(settings.gemini_api_key),
        "max_retries": settings.max_retry_iterations,
    }


# Include Webhook Router
app.include_router(webhook_router)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "app.main:app",
        host=settings.host,
        port=settings.port,
        reload=settings.environment == "development",
    )
