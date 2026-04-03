"""
Open Seed v2 — GitHub PR comment fetcher.

Fetches all PR comments (conversation, reviews, inline review threads)
using gh CLI GraphQL API. Returns structured data for auto-fix pipeline.

Pattern from: OpenAI skills/gh-address-comments/fetch_comments.py
Uses gh CLI (OAuth) — no API keys.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from openseed_core.subprocess import run_simple

# ─── GraphQL Query ───────────────────────────────────────────────────────────

_GRAPHQL_QUERY = """\
query(
  $owner: String!,
  $repo: String!,
  $number: Int!,
  $commentsCursor: String,
  $reviewsCursor: String,
  $threadsCursor: String
) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      number
      url
      title
      state
      comments(first: 100, after: $commentsCursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          body
          createdAt
          author { login }
        }
      }
      reviews(first: 100, after: $reviewsCursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          state
          body
          submittedAt
          author { login }
        }
      }
      reviewThreads(first: 100, after: $threadsCursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          comments(first: 100) {
            nodes {
              id
              body
              createdAt
              author { login }
            }
          }
        }
      }
    }
  }
}
"""


# ─── Types ───────────────────────────────────────────────────────────────────


@dataclass
class PRComment:
    """A single PR comment (conversation, review, or inline thread)."""

    id: str = ""
    author: str = ""
    body: str = ""
    comment_type: str = ""  # "conversation", "review", "inline"
    file_path: str = ""  # Only for inline comments
    line: int | None = None  # Only for inline comments
    is_resolved: bool = False
    created_at: str = ""


@dataclass
class PRCommentResult:
    """All comments on a PR, structured for processing."""

    pr_number: int = 0
    pr_url: str = ""
    pr_title: str = ""
    comments: list[PRComment] = field(default_factory=list)
    actionable_count: int = 0  # Unresolved, non-empty comments


# ─── Public API ──────────────────────────────────────────────────────────────


async def fetch_pr_comments(
    working_dir: str,
    pr_number: int | None = None,
) -> PRCommentResult:
    """
    Fetch all comments on a PR via gh CLI GraphQL.

    Args:
        working_dir: Git repository root.
        pr_number: PR number (auto-detects from current branch if None).

    Returns:
        PRCommentResult with all comments structured by type.
    """
    # Verify gh CLI
    gh_check = await run_simple(["gh", "auth", "status"], timeout_seconds=5)
    if gh_check.exit_code != 0:
        return PRCommentResult()

    # Resolve PR metadata
    owner, repo, number = await _resolve_pr(working_dir, pr_number)
    if not number:
        return PRCommentResult()

    # Fetch all comments with pagination
    all_comments: list[PRComment] = []
    pr_url = ""
    pr_title = ""

    comments_cursor: str | None = None
    reviews_cursor: str | None = None
    threads_cursor: str | None = None

    while True:
        data = await _graphql_query(
            working_dir,
            owner,
            repo,
            number,
            comments_cursor,
            reviews_cursor,
            threads_cursor,
        )
        if not data:
            break

        pr = data.get("data", {}).get("repository", {}).get("pullRequest", {})
        if not pr:
            break

        pr_url = pr_url or pr.get("url", "")
        pr_title = pr_title or pr.get("title", "")

        # Conversation comments
        c = pr.get("comments", {})
        for node in c.get("nodes", []):
            all_comments.append(
                PRComment(
                    id=node.get("id", ""),
                    author=node.get("author", {}).get("login", ""),
                    body=node.get("body", ""),
                    comment_type="conversation",
                    created_at=node.get("createdAt", ""),
                )
            )

        # Review submissions
        r = pr.get("reviews", {})
        for node in r.get("nodes", []):
            body = node.get("body", "").strip()
            if body:  # Skip empty reviews (approve-only)
                all_comments.append(
                    PRComment(
                        id=node.get("id", ""),
                        author=node.get("author", {}).get("login", ""),
                        body=body,
                        comment_type="review",
                        created_at=node.get("submittedAt", ""),
                    )
                )

        # Inline review threads
        t = pr.get("reviewThreads", {})
        for node in t.get("nodes", []):
            is_resolved = node.get("isResolved", False)
            path = node.get("path", "")
            line = node.get("line")
            for comment in node.get("comments", {}).get("nodes", []):
                all_comments.append(
                    PRComment(
                        id=comment.get("id", ""),
                        author=comment.get("author", {}).get("login", ""),
                        body=comment.get("body", ""),
                        comment_type="inline",
                        file_path=path,
                        line=line,
                        is_resolved=is_resolved,
                        created_at=comment.get("createdAt", ""),
                    )
                )

        # Pagination
        comments_cursor = c.get("pageInfo", {}).get("endCursor") if c.get("pageInfo", {}).get("hasNextPage") else None
        reviews_cursor = r.get("pageInfo", {}).get("endCursor") if r.get("pageInfo", {}).get("hasNextPage") else None
        threads_cursor = t.get("pageInfo", {}).get("endCursor") if t.get("pageInfo", {}).get("hasNextPage") else None

        if not (comments_cursor or reviews_cursor or threads_cursor):
            break

    actionable = sum(1 for c in all_comments if not c.is_resolved and c.body.strip())

    return PRCommentResult(
        pr_number=number,
        pr_url=pr_url,
        pr_title=pr_title,
        comments=all_comments,
        actionable_count=actionable,
    )


def format_comments_for_prompt(result: PRCommentResult) -> str:
    """Format PR comments into a string for injection into fix prompts."""
    if not result.comments:
        return ""

    parts = [f"PR #{result.pr_number}: {result.pr_title} ({result.actionable_count} actionable comments)"]

    for i, c in enumerate(result.comments, 1):
        if c.is_resolved:
            continue
        if not c.body.strip():
            continue

        prefix = f"\n{i}. [{c.comment_type}] @{c.author}"
        if c.file_path:
            prefix += f" on {c.file_path}"
            if c.line:
                prefix += f":{c.line}"
        parts.append(f"{prefix}:\n   {c.body[:500]}")

    return "\n".join(parts)


# ─── Private helpers ─────────────────────────────────────────────────────────


async def _resolve_pr(
    working_dir: str,
    pr_number: int | None,
) -> tuple[str, str, int]:
    """Resolve owner, repo, and PR number."""
    if pr_number:
        # Get repo info from gh
        result = await run_simple(
            ["gh", "repo", "view", "--json", "owner,name"],
            cwd=working_dir,
            timeout_seconds=10,
        )
        if result.exit_code != 0:
            return "", "", 0
        try:
            data = json.loads(result.stdout)
            return data.get("owner", {}).get("login", ""), data.get("name", ""), pr_number
        except (json.JSONDecodeError, TypeError):
            return "", "", 0

    # Auto-detect from current branch
    result = await run_simple(
        ["gh", "pr", "view", "--json", "number,headRepositoryOwner,headRepository"],
        cwd=working_dir,
        timeout_seconds=10,
    )
    if result.exit_code != 0:
        return "", "", 0

    try:
        data = json.loads(result.stdout)
        owner = data.get("headRepositoryOwner", {}).get("login", "")
        repo = data.get("headRepository", {}).get("name", "")
        number = int(data.get("number", 0))
        return owner, repo, number
    except (json.JSONDecodeError, TypeError, ValueError):
        return "", "", 0


async def _graphql_query(
    working_dir: str,
    owner: str,
    repo: str,
    number: int,
    comments_cursor: str | None = None,
    reviews_cursor: str | None = None,
    threads_cursor: str | None = None,
) -> dict[str, Any]:
    """Execute GraphQL query via gh CLI."""
    cmd = [
        "gh",
        "api",
        "graphql",
        "-F",
        "query=@-",
        "-F",
        f"owner={owner}",
        "-F",
        f"repo={repo}",
        "-F",
        f"number={number}",
    ]
    if comments_cursor:
        cmd += ["-F", f"commentsCursor={comments_cursor}"]
    if reviews_cursor:
        cmd += ["-F", f"reviewsCursor={reviews_cursor}"]
    if threads_cursor:
        cmd += ["-F", f"threadsCursor={threads_cursor}"]

    # Pass query via stdin using a temporary approach
    import os
    import tempfile

    fd, tmp = tempfile.mkstemp(suffix=".graphql")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(_GRAPHQL_QUERY)
        # Replace @- with @file
        cmd[cmd.index("query=@-")] = f"query=@{tmp}"
        result = await run_simple(cmd, cwd=working_dir, timeout_seconds=30)
    finally:
        os.unlink(tmp)

    if result.exit_code != 0:
        return {}

    try:
        return json.loads(result.stdout)
    except (json.JSONDecodeError, TypeError):
        return {}
