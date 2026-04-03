"""Open Seed v2 — Memory (long-term learning)."""

from openseed_memory.backends import MemoryBackend, SQLiteMemoryBackend, create_backend
from openseed_memory.condenser import (
    Condenser,
    LLMSummaryCondenser,
    PipelineCondenser,
    RecentCondenser,
    condense_for_prompt,
)
from openseed_memory.fact_extractor import FactExtractor, MemoryDecision
from openseed_memory.failure import recall_similar_failures, record_failure
from openseed_memory.procedural import recall_fix_strategies, recall_procedures, store_fix_strategy, store_procedure
from openseed_memory.reranker import Reranker
from openseed_memory.store import MemoryStore
from openseed_memory.types import FailurePattern, MemoryEntry, MemoryType, SearchResult
from openseed_memory.wisdom import (
    Wisdom,
    extract_wisdom,
    format_wisdom_for_prompt,
    recall_wisdom,
    store_wisdom,
)

__all__ = [
    "MemoryStore",
    "record_failure",
    "recall_similar_failures",
    "store_procedure",
    "recall_procedures",
    "store_fix_strategy",
    "recall_fix_strategies",
    "MemoryEntry",
    "MemoryType",
    "FailurePattern",
    "SearchResult",
    "FactExtractor",
    "MemoryDecision",
    "Reranker",
    # backends
    "MemoryBackend",
    "SQLiteMemoryBackend",
    "create_backend",
    # Wisdom (Oh-My-OpenAgent pattern)
    "Wisdom",
    "extract_wisdom",
    "store_wisdom",
    "recall_wisdom",
    "format_wisdom_for_prompt",
    # Condenser (OpenHands pattern)
    "Condenser",
    "RecentCondenser",
    "LLMSummaryCondenser",
    "PipelineCondenser",
    "condense_for_prompt",
]
