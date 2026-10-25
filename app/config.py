"""Configuration management for DevOpsPilot using Pydantic Settings."""

from functools import lru_cache
from pathlib import Path
from typing import Optional
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application configuration settings loaded from environment or .env file."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Server Settings
    host: str = Field(default="0.0.0.0", description="API server bind host")
    port: int = Field(default=8000, description="API server bind port")
    environment: str = Field(default="development", description="Runtime environment")
    log_level: str = Field(default="INFO", description="Standard logging level")

    # GitHub Integration
    github_token: str = Field(default="", description="GitHub PAT / App token with repo scope")
    github_webhook_secret: str = Field(
        default="", description="Secret key configured for webhook HMAC verification"
    )
    github_app_id: Optional[str] = Field(default=None, description="GitHub App ID")
    github_app_private_key: Optional[str] = Field(
        default=None, description="GitHub App Private Key (.pem raw content)"
    )
    github_app_private_key_path: Optional[str] = Field(
        default=None, description="Path to GitHub App Private Key (.pem file)"
    )
    github_app_installation_id: Optional[int] = Field(
        default=None, description="GitHub App Installation ID"
    )

    # LLM Settings (Google AI Studio & Groq Cloud)
    llm_provider: str = Field(
        default="gemini", description="Active LLM provider: 'gemini' or 'groq'"
    )
    gemini_api_key: str = Field(default="", description="Google Gemini API Key")
    gemini_model: str = Field(
        default="gemini-2.5-flash",
        description="Gemini model identifier (e.g. gemini-2.5-flash)",
    )
    groq_api_key: str = Field(default="", description="Groq Cloud API Key")
    groq_model: str = Field(
        default="llama-3.3-70b-versatile",
        description="Groq model identifier (e.g. llama-3.3-70b-versatile)",
    )

    # Workspace & Sandboxing
    workspace_base_dir: Path = Field(
        default=Path("./workspaces"),
        description="Base directory where ephemeral workspaces are cloned",
    )
    docker_sandbox_image: str = Field(
        default="node:20-alpine",
        description="Default Docker container image for build/test execution",
    )
    docker_timeout_seconds: int = Field(
        default=120, description="Max execution time for sandboxed test command in seconds"
    )
    use_docker_sandbox: bool = Field(
        default=True,
        description="Attempt to run in Docker container. Falls back safely if unavailable",
    )

    # Agent Guardrails
    max_retry_iterations: int = Field(
        default=3, description="Maximum diagnosis/repair retry iterations per job"
    )
    max_log_lines: int = Field(
        default=150, description="Max log lines to send to LLM context"
    )
    enable_secret_scanning: bool = Field(
        default=True, description="Enable pre-commit secret detection on generated patches"
    )


@lru_cache()
def get_settings() -> Settings:
    """Return cached application settings instance."""
    return Settings()
