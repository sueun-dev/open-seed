"""Open Seed v2 — Sisyphus (infinite retry loop until zero errors)."""

from openseed_sisyphus.loop import evaluate_loop, LoopState, LoopDecision, run_sisyphus
from openseed_sisyphus.progress import ProgressTracker, ProgressSnapshot, ProgressUpdate
from openseed_sisyphus.stagnation import is_stagnated
from openseed_sisyphus.backoff import compute_backoff_ms, should_retry
from openseed_sisyphus.oracle import consult_oracle, OracleAdvice
from openseed_sisyphus.evidence import verify_implementation, VerificationResult
from openseed_sisyphus.intent_gate import IntentType, IntentClassification, classify_intent
from openseed_sisyphus.execution_loop import ExecutionLoop, ExecutionResult
from openseed_sisyphus.delegation import build_delegation_prompt
from openseed_sisyphus.prompts import ModelFamily, PromptVariant, detect_model_family

__all__ = [
    # Loop
    "evaluate_loop", "LoopState", "LoopDecision", "run_sisyphus",
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
