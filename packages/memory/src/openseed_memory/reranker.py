"""LLM-based reranking — takes vector/FTS search results and re-scores by relevance."""

from __future__ import annotations

import json
import logging

from openseed_memory.types import SearchResult

logger = logging.getLogger(__name__)

_RERANK_PROMPT = """\
You are a memory relevance ranker. Given a query and a list of memory entries, \
return the IDs reordered from most to least relevant to the query.

Return ONLY a valid JSON array of IDs in order. No commentary.

Query: {query}

Memories:
{memories}

Return JSON array of IDs only (most relevant first):"""


class Reranker:
    """
    LLM-based reranker. Uses Claude Haiku to reorder search results by
    semantic relevance to the query, improving recall quality.
    """

    def __init__(self, cli_path: str | None = None, model: str = "claude-haiku-4-5") -> None:
        self._cli_path = cli_path
        self._model = model

    def _get_cli(self) -> str | None:
        if self._cli_path:
            return self._cli_path
        try:
            from openseed_core.auth.claude import get_claude_cli_path
            return get_claude_cli_path()
        except Exception:
            return None

    async def rerank(
        self,
        query: str,
        results: list[SearchResult],
    ) -> list[SearchResult]:
        """
        Rerank search results by LLM relevance score.

        Falls back to the original order if CLI is unavailable or the call fails.
        """
        if len(results) <= 1:
            return results

        cli = self._get_cli()
        if not cli:
            return results

        memories_text = "\n".join(
            f"[{r.entry.id}] {r.entry.content[:300]}" for r in results
        )

        prompt = _RERANK_PROMPT.format(
            query=query[:500],
            memories=memories_text,
        )

        cmd = [
            cli,
            "--print",
            "--dangerously-skip-permissions",
            "--model", self._model,
            "--max-turns", "1",
            prompt,
        ]

        try:
            from openseed_core.subprocess import run_streaming
            result = await run_streaming(cmd, timeout_seconds=30)
            raw_output = result.stdout.strip()
        except Exception as exc:
            logger.debug("Reranker LLM call failed, keeping original order: %s", exc)
            return results

        return self._apply_ranking(raw_output, results)

    def _apply_ranking(self, raw: str, original: list[SearchResult]) -> list[SearchResult]:
        """Apply the LLM-returned ID ordering. Falls back gracefully."""
        start = raw.find("[")
        end = raw.rfind("]")
        if start == -1 or end == -1:
            return original

        try:
            ordered_ids: list[str] = json.loads(raw[start : end + 1])
        except (json.JSONDecodeError, ValueError):
            return original

        if not isinstance(ordered_ids, list):
            return original

        # Build id -> result lookup
        by_id = {r.entry.id: r for r in original}

        reranked: list[SearchResult] = []
        seen: set[str] = set()

        for mem_id in ordered_ids:
            mem_id = str(mem_id)
            if mem_id in by_id and mem_id not in seen:
                reranked.append(by_id[mem_id])
                seen.add(mem_id)

        # Append any results the LLM omitted (preserve original tail)
        for r in original:
            if r.entry.id not in seen:
                reranked.append(r)

        return reranked if reranked else original
