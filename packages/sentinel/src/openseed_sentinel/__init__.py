"""Open Seed v2 — Sentinel (infinite retry loop until zero errors)."""

from openseed_sentinel.loop import evaluate_loop, LoopState, LoopDecision, run_sentinel
from openseed_sentinel.progress import ProgressTracker, ProgressSnapshot, ProgressUpdate
from openseed_sentinel.stagnation import is_stagnated
from openseed_sentinel.backoff import compute_backoff_ms, should_retry
from openseed_sentinel.oracle import consult_oracle, OracleAdvice
from openseed_sentinel.evidence import verify_implementation, VerificationResult
from openseed_sentinel.intent_gate import IntentType, IntentClassification, classify_intent
from openseed_sentinel.execution_loop import ExecutionLoop, ExecutionResult
from openseed_sentinel.delegation import build_delegation_prompt
from openseed_sentinel.prompts import ModelFamily, PromptVariant, detect_model_family

__all__ = [
    # Loop
    "evaluate_loop", "LoopState", "LoopDecision", "run_sentinel",
    # Progress
    "ProgressTracker", "ProgressSnapshot", "ProgressUpdate",
    # Stagnation / backoff
    "is_stagnated", "compute_backoff_ms", "should_retry",
    # Oracle
    "consult_oracle", "OracleAdvice",
    # Evidence
    "verify_implementation", "VerificationResult",
    # Intent Gate
    "IntentType", "IntentClassification", "classify_intent",
    # Execution Loop
    "ExecutionLoop", "ExecutionResult",
    # Delegation
    "build_delegation_prompt",
    # Multi-model prompts
    "ModelFamily", "PromptVariant", "detect_model_family",
]
