"""
Open Seed v2 — GitHub/GitLab Issue Reader (OpenHands pattern).

Reads issue details from GitHub/GitLab via CLI tools (gh/glab).
Extracts title, body, comments, labels — feeds into pipeline intake.

OAuth only — uses gh CLI which authenticates via browser OAuth.

Pattern from: openhands/resolver/issue_handler.py
"""

from __future__ import annotations

from dataclasses import dataclass, field

from openseed_core.subprocess import run_simple


@dataclass
class IssueContext:
    """Parsed issue ready for pipeline intake."""

    number: int
    title: str
    body: str
    labels: list[str] = field(default_factory=list)
    comments: list[str] = field(default_factory=list)
    author: str = ""
    repo: str = ""
    url: str = ""

    def to_task(self) -> str:
        """Convert issue to a task description for the pipeline."""
        parts = [f"Fix GitHub issue #{self.number}: {self.title}"]
        if self.body:
            parts.append(f"\nDescription:\n{self.body[:3000]}")
        if self.labels:
            parts.append(f"\nLabels: {', '.join(self.labels)}")
        if self.comments:
            parts.append("\nRelevant comments:")
            for c in self.comments[:5]:
                parts.append(f"- {c[:500]}")
        return "\n".join(parts)


async def read_github_issue(repo: str, issue_number: int) -> IssueContext:
    """
    Read a GitHub issue using the gh CLI (OAuth, no API key).

    Args:
        repo: Repository in "owner/name" format
        issue_number: Issue number

    Returns:
        IssueContext with all issue details

    Raises:
        RuntimeError: If gh CLI is not available or issue not found
    """
    import json

    # Check gh CLI is available
    check = await run_simple(["gh", "--version"], timeout_seconds=5)
    if check.exit_code != 0:
        raise RuntimeError(
            "gh CLI not installed. Install from https://cli.github.com/ "
            "and run 'gh auth login' for OAuth authentication."
        )

    # Fetch issue details
    result = await run_simple(
        [
            "gh",
            "issue",
            "view",
            str(issue_number),
            "--repo",
            repo,
            "--json",
            "title,body,labels,comments,author,url",
        ],
        timeout_seconds=15,
    )
    if result.exit_code != 0:
        raise RuntimeError(f"Failed to read issue #{issue_number}: {result.stderr}")

    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Invalid response from gh CLI: {result.stdout[:500]}") from exc

    labels = [lb.get("name", "") for lb in data.get("labels", [])]
    comments = [c.get("body", "") for c in data.get("comments", []) if c.get("body")]

    return IssueContext(
        number=issue_number,
        title=data.get("title", ""),
        body=data.get("body", ""),
        labels=labels,
        comments=comments,
        author=data.get("author", {}).get("login", ""),
        repo=repo,
        url=data.get("url", ""),
    )


async def read_gitlab_issue(repo: str, issue_number: int) -> IssueContext:
    """
    Read a GitLab issue using the glab CLI (OAuth).

    Args:
        repo: Repository in "group/name" format
        issue_number: Issue number

    Returns:
        IssueContext with issue details
    """
    import json

    check = await run_simple(["glab", "--version"], timeout_seconds=5)
    if check.exit_code != 0:
        raise RuntimeError("glab CLI not installed.")

    result = await run_simple(
        [
            "glab",
            "issue",
            "view",
            str(issue_number),
            "--repo",
            repo,
            "--output",
            "json",
        ],
        timeout_seconds=15,
    )
    if result.exit_code != 0:
        raise RuntimeError(f"Failed to read GitLab issue #{issue_number}: {result.stderr}")

    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Invalid response from glab CLI: {result.stdout[:500]}") from exc

    return IssueContext(
        number=issue_number,
        title=data.get("title", ""),
        body=data.get("description", ""),
        labels=data.get("labels", []),
        author=data.get("author", {}).get("username", ""),
        repo=repo,
        url=data.get("web_url", ""),
    )
