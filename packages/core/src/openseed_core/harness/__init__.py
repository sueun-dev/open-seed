"""Harness engineering: automated project scaffold and quality checks."""

from openseed_core.harness.checker import HarnessScore, check_harness_quality
from openseed_core.harness.generator import generate_scaffold

__all__ = [
    "HarnessScore",
    "check_harness_quality",
    "generate_scaffold",
]
