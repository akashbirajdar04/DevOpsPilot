"""GitHub REST API client for log fetching, branch management, and pull request delivery."""

import logging
import time
from pathlib import Path
from typing import Any, Dict, Optional
import httpx
import jwt
from github import Github, GithubException

from app.config import get_settings

logger = logging.getLogger(__name__)


class GitHubClient:
    """Handles GitHub API operations: fetching workflow logs, pushing commits, and opening PRs.
    Supports both Personal Access Tokens (PAT) and GitHub App private key (.pem) authentication.
    """

    def __init__(self, token: Optional[str] = None, settings: Optional[Any] = None):
        self.settings = settings or get_settings()
        self._explicit_token = token
        self._cached_app_token: Optional[str] = None
        self._cached_app_token_expiry: float = 0
        self._gh: Optional[Github] = None

    def _get_private_key(self) -> Optional[str]:
        """Load GitHub App private key from environment variable or file path."""
        if self.settings.github_app_private_key:
            return self.settings.github_app_private_key.strip()
        if self.settings.github_app_private_key_path:
            key_path = Path(self.settings.github_app_private_key_path)
            if key_path.exists():
                return key_path.read_text(encoding="utf-8").strip()
            else:
                logger.error("GitHub App private key path does not exist: %s", key_path)
        return None

    def _generate_app_jwt(self) -> Optional[str]:
        """Generate a signed RS256 JWT for GitHub App authentication."""
        app_id = self.settings.github_app_id
        private_key = self._get_private_key()

        if not app_id or not private_key:
            return None

        now = int(time.time())
        payload = {
            "iat": now - 60,         # 1 minute clock drift allowance
            "exp": now + (10 * 60),  # Valid for 10 minutes max
            "iss": app_id,
        }
        try:
            token = jwt.encode(payload, private_key, algorithm="RS256")
            return token if isinstance(token, str) else token.decode("utf-8")
        except Exception as e:
            logger.error("Failed to generate GitHub App JWT: %s", e)
            return None

    def get_token(self, installation_id: Optional[int] = None) -> str:
        """
        Get valid authentication token:
        1. Explicitly provided or configured GITHUB_TOKEN (PAT)
        2. Cached GitHub App installation access token
        3. Fresh installation token exchanged via GitHub App JWT
        """
        if self._explicit_token:
            return self._explicit_token
        if self.settings.github_token:
            return self.settings.github_token

        # Check if we have a valid unexpired App installation token
        now = time.time()
        if self._cached_app_token and now < (self._cached_app_token_expiry - 120):
            return self._cached_app_token

        # Exchange GitHub App JWT for installation access token
        inst_id = installation_id or self.settings.github_app_installation_id
        app_jwt = self._generate_app_jwt()

        if app_jwt and inst_id:
            try:
                url = f"https://api.github.com/app/installations/{inst_id}/access_tokens"
                headers = {
                    "Authorization": f"Bearer {app_jwt}",
                    "Accept": "application/vnd.github+json",
                }
                with httpx.Client(timeout=15.0) as client:
                    resp = client.post(url, headers=headers)
                    if resp.status_code == 201:
                        data = resp.json()
                        token = data["token"]
                        self._cached_app_token = token
                        # Tokens generally last 1 hour (3600 seconds)
                        self._cached_app_token_expiry = now + 3500
                        logger.info("Successfully minted dynamic GitHub App installation token.")
                        return token
                    else:
                        logger.error(
                            "Failed to exchange GitHub App JWT for token: HTTP %d - %s",
                            resp.status_code,
                            resp.text,
                        )
            except Exception as e:
                logger.error("Exception fetching installation token: %s", e)

        return ""

    @property
    def gh(self) -> Github:
        """Lazy initialization of PyGithub client with current token."""
        token = self.get_token()
        if not self._gh:
            self._gh = Github(token) if token else Github()
        return self._gh

    def get_auth_headers(self) -> Dict[str, str]:
        """Headers for direct httpx REST calls."""
        headers = {
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "DevOpsPilot-SelfHealingCI/0.1.0",
        }
        token = self.get_token()
        if token:
            headers["Authorization"] = f"Bearer {token}"
        return headers

    async def fetch_job_logs(self, repo_full_name: str, job_id: int) -> str:
        """
        Download raw plain text logs for a specific GitHub Actions job.
        Follows 302 redirects automatically to the log storage blob.
        """
        url = f"https://api.github.com/repos/{repo_full_name}/actions/jobs/{job_id}/logs"
        logger.info("Fetching job logs from %s", url)

        async with httpx.AsyncClient(follow_redirects=True, timeout=30.0) as client:
            response = await client.get(url, headers=self.get_auth_headers())
            if response.status_code == 200:
                return response.text
            elif response.status_code == 404:
                logger.warning("Log not found (404) for job %s in repo %s", job_id, repo_full_name)
                return ""
            else:
                logger.error(
                    "Failed to fetch logs for job %s: HTTP %s - %s",
                    job_id,
                    response.status_code,
                    response.text[:200],
                )
                response.raise_for_status()
                return ""

    def create_pull_request(
        self,
        repo_full_name: str,
        title: str,
        body: str,
        head_branch: str,
        base_branch: str = "main",
    ) -> Dict[str, Any]:
        """
        Create a pull request using PyGithub.
        Returns dict containing pr_number, html_url, and state.
        """
        logger.info(
            "Creating PR in %s from %s to %s: '%s'",
            repo_full_name,
            head_branch,
            base_branch,
            title,
        )

        try:
            repo = self.gh.get_repo(repo_full_name)
            pr = repo.create_pull(
                title=title,
                body=body,
                head=head_branch,
                base=base_branch,
            )
            logger.info("Successfully opened PR #%d at %s", pr.number, pr.html_url)
            return {
                "pr_number": pr.number,
                "html_url": pr.html_url,
                "state": pr.state,
                "id": pr.id,
            }
        except GithubException as e:
            logger.error("GitHub API exception creating PR: %s", e)
            raise

    @staticmethod
    def generate_pr_body(
        job_id: int,
        run_id: int,
        root_cause_analysis: str,
        modified_files: list[str],
        test_command: str,
        test_output: str,
        iterations: int,
        confidence_rating: str = "High",
    ) -> str:
        """Formats the Markdown pull request description for automated remediation."""
        files_list = "\n".join([f"- `{f}`" for f in modified_files]) or "- *None*"

        body = f"""## 🛠️ Automated CI Remediation

**Failed Job ID**: [#{job_id}](https://github.com/actions/runs/{run_id})  
**Remediation Engine**: DevOpsPilot (Autonomous Loop)  
**Verification Status**: ✅ Build & Test Passed in Sandbox (Exit Code: 0)  
**Iterations Used**: {iterations} / 3  
**Confidence Rating**: {confidence_rating}

---

### 🔍 Root-Cause Analysis
{root_cause_analysis}

---

### 📝 Files Modified
{files_list}

---

### 🧪 Verification Sandbox Run
**Command Executed:**
```bash
{test_command}
```

<details>
<summary>Click to view sandbox verification test log</summary>

```text
{test_output[-1500:] if len(test_output) > 1500 else test_output}
```
</details>

---

*This pull request was automatically generated and verified by DevOpsPilot.*
"""
        return body
