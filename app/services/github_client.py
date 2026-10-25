"""GitHub REST API client for log fetching, branch management, and pull request delivery."""

import logging
from typing import Any, Dict, Optional
import httpx
from github import Github, GithubException

from app.config import get_settings

logger = logging.getLogger(__name__)


class GitHubClient:
    """Handles GitHub API operations: fetching workflow logs, pushing commits, and opening PRs."""

    def __init__(self, token: Optional[str] = None):
        self.settings = get_settings()
        self.token = token or self.settings.github_token
        self._gh: Optional[Github] = None

    @property
    def gh(self) -> Github:
        """Lazy initialization of PyGithub client."""
        if not self._gh:
            self._gh = Github(self.token) if self.token else Github()
        return self._gh

    def get_auth_headers(self) -> Dict[str, str]:
        """Headers for direct httpx REST calls."""
        headers = {
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "DevOpsPilot-SelfHealingCI/0.1.0",
        }
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
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
**Remediation Engine**: DevOpsPilot (Gemini 2.5 Flash / Autonomous Loop)  
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
