"""
Agent category system — organizes 130+ agents into 10 categories.
Pattern from: awesome-codex-subagents directory structure.

Categories enable:
- Task-based agent selection (only pick from relevant categories)
- Role-fit matching (read-only vs write agents)
- Expertise routing (language specialist vs infra vs security)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path

from openseed_qa_gate.types import AgentDefinition
from openseed_qa_gate.agent_loader import load_agents_from_dir


class AgentCategory(str, Enum):
    CORE_DEVELOPMENT = "01-core-development"
    LANGUAGE_SPECIALISTS = "02-language-specialists"
    INFRASTRUCTURE = "03-infrastructure"
    QUALITY_SECURITY = "04-quality-security"
    DATA_AI = "05-data-ai"
    DEVELOPER_EXPERIENCE = "06-developer-experience"
    SPECIALIZED_DOMAINS = "07-specialized-domains"
    BUSINESS_PRODUCT = "08-business-product"
    META_ORCHESTRATION = "09-meta-orchestration"
    RESEARCH_ANALYSIS = "10-research-analysis"


_CATEGORY_METADATA: dict[AgentCategory, tuple[str, str]] = {
    AgentCategory.CORE_DEVELOPMENT: (
        "Core Development",
        "Full-stack, frontend, backend, API, and architecture specialists",
    ),
    AgentCategory.LANGUAGE_SPECIALISTS: (
        "Language Specialists",
        "Language- and framework-specific experts (Python, Rust, Go, React, etc.)",
    ),
    AgentCategory.INFRASTRUCTURE: (
        "Infrastructure",
        "DevOps, cloud, Kubernetes, Terraform, SRE, and platform engineers",
    ),
    AgentCategory.QUALITY_SECURITY: (
        "Quality & Security",
        "Code review, QA, security auditing, debugging, and compliance",
    ),
    AgentCategory.DATA_AI: (
        "Data & AI",
        "Data engineers, ML/AI specialists, LLM architects, and database experts",
    ),
    AgentCategory.DEVELOPER_EXPERIENCE: (
        "Developer Experience",
        "Tooling, CI/CD, documentation, refactoring, and DX optimization",
    ),
    AgentCategory.SPECIALIZED_DOMAINS: (
        "Specialized Domains",
        "Blockchain, embedded systems, fintech, IoT, and niche verticals",
    ),
    AgentCategory.BUSINESS_PRODUCT: (
        "Business & Product",
        "Product management, business analysis, technical writing, and UX",
    ),
    AgentCategory.META_ORCHESTRATION: (
        "Meta-Orchestration",
        "Multi-agent coordination, workflow orchestration, and task distribution",
    ),
    AgentCategory.RESEARCH_ANALYSIS: (
        "Research & Analysis",
        "Market research, competitive analysis, trend analysis, and data research",
    ),
}


@dataclass
class CategoryInfo:
    category: AgentCategory
    name: str
    description: str
    agents: list[AgentDefinition] = field(default_factory=list)


def load_all_categories(agents_dir: Path) -> dict[AgentCategory, CategoryInfo]:
    """Load all agent categories with their agents.

    Expects agents_dir to contain subdirectories named after each AgentCategory
    value (e.g. ``01-core-development/``, ``02-language-specialists/``).
    """
    result: dict[AgentCategory, CategoryInfo] = {}

    for category in AgentCategory:
        cat_dir = agents_dir / category.value
        display_name, description = _CATEGORY_METADATA[category]
        agents_map = load_agents_from_dir(cat_dir)
        result[category] = CategoryInfo(
            category=category,
            name=display_name,
            description=description,
            agents=list(agents_map.values()),
        )

    return result


# Task-type → relevant categories mapping
_TASK_CATEGORY_MAP: dict[str, list[AgentCategory]] = {
    # implementation / coding
    "implementation": [
        AgentCategory.CORE_DEVELOPMENT,
        AgentCategory.LANGUAGE_SPECIALISTS,
    ],
    "coding": [
        AgentCategory.CORE_DEVELOPMENT,
        AgentCategory.LANGUAGE_SPECIALISTS,
    ],
    "feature": [
        AgentCategory.CORE_DEVELOPMENT,
        AgentCategory.LANGUAGE_SPECIALISTS,
    ],
    "bug": [
        AgentCategory.QUALITY_SECURITY,
        AgentCategory.CORE_DEVELOPMENT,
    ],
    "debug": [
        AgentCategory.QUALITY_SECURITY,
        AgentCategory.CORE_DEVELOPMENT,
    ],
    # security
    "security": [AgentCategory.QUALITY_SECURITY],
    "audit": [AgentCategory.QUALITY_SECURITY],
    "pentest": [AgentCategory.QUALITY_SECURITY],
    # infrastructure / deployment
    "deploy": [AgentCategory.INFRASTRUCTURE],
    "deployment": [AgentCategory.INFRASTRUCTURE],
    "infra": [AgentCategory.INFRASTRUCTURE],
    "infrastructure": [AgentCategory.INFRASTRUCTURE],
    "cloud": [AgentCategory.INFRASTRUCTURE],
    "devops": [AgentCategory.INFRASTRUCTURE],
    "kubernetes": [AgentCategory.INFRASTRUCTURE],
    # review
    "review": [
        AgentCategory.QUALITY_SECURITY,
        AgentCategory.META_ORCHESTRATION,
    ],
    "code_review": [
        AgentCategory.QUALITY_SECURITY,
        AgentCategory.META_ORCHESTRATION,
    ],
    # data / AI
    "data": [AgentCategory.DATA_AI],
    "ml": [AgentCategory.DATA_AI],
    "ai": [AgentCategory.DATA_AI],
    "llm": [AgentCategory.DATA_AI],
    "database": [AgentCategory.DATA_AI, AgentCategory.INFRASTRUCTURE],
    # testing / QA
    "test": [AgentCategory.QUALITY_SECURITY],
    "qa": [AgentCategory.QUALITY_SECURITY],
    # documentation / DX
    "docs": [AgentCategory.DEVELOPER_EXPERIENCE],
    "documentation": [AgentCategory.DEVELOPER_EXPERIENCE],
    "dx": [AgentCategory.DEVELOPER_EXPERIENCE],
    "refactor": [AgentCategory.DEVELOPER_EXPERIENCE],
    # research / analysis
    "research": [AgentCategory.RESEARCH_ANALYSIS],
    "analysis": [AgentCategory.RESEARCH_ANALYSIS],
    "competitive": [AgentCategory.RESEARCH_ANALYSIS],
    "market": [AgentCategory.RESEARCH_ANALYSIS],
    # orchestration
    "orchestration": [AgentCategory.META_ORCHESTRATION],
    "coordination": [AgentCategory.META_ORCHESTRATION],
    "workflow": [AgentCategory.META_ORCHESTRATION],
    # business / product
    "product": [AgentCategory.BUSINESS_PRODUCT],
    "business": [AgentCategory.BUSINESS_PRODUCT],
    "ux": [AgentCategory.BUSINESS_PRODUCT],
    # specialized domains
    "blockchain": [AgentCategory.SPECIALIZED_DOMAINS],
    "fintech": [AgentCategory.SPECIALIZED_DOMAINS],
    "iot": [AgentCategory.SPECIALIZED_DOMAINS],
    "embedded": [AgentCategory.SPECIALIZED_DOMAINS],
    "mobile": [
        AgentCategory.SPECIALIZED_DOMAINS,
        AgentCategory.LANGUAGE_SPECIALISTS,
    ],
}

# Default fallback if no task type is matched
_DEFAULT_CATEGORIES: list[AgentCategory] = [
    AgentCategory.CORE_DEVELOPMENT,
    AgentCategory.QUALITY_SECURITY,
]


def get_categories_for_task(task_type: str) -> list[AgentCategory]:
    """Map a task type string to the relevant agent categories.

    The lookup is case-insensitive and uses the longest matching key.
    Falls back to core-development + quality-security if no match.

    Examples::

        get_categories_for_task("security")
        # → [AgentCategory.QUALITY_SECURITY]

        get_categories_for_task("implementation")
        # → [AgentCategory.CORE_DEVELOPMENT, AgentCategory.LANGUAGE_SPECIALISTS]

        get_categories_for_task("deploy")
        # → [AgentCategory.INFRASTRUCTURE]

        get_categories_for_task("review")
        # → [AgentCategory.QUALITY_SECURITY, AgentCategory.META_ORCHESTRATION]
    """
    normalized = task_type.strip().lower().replace("-", "_").replace(" ", "_")

    # Exact match first
    if normalized in _TASK_CATEGORY_MAP:
        return list(_TASK_CATEGORY_MAP[normalized])

    # Substring match — find all keys contained in the task_type string
    matches: list[AgentCategory] = []
    seen: set[AgentCategory] = set()
    for key, cats in _TASK_CATEGORY_MAP.items():
        if key in normalized:
            for cat in cats:
                if cat not in seen:
                    matches.append(cat)
                    seen.add(cat)

    return matches if matches else list(_DEFAULT_CATEGORIES)
