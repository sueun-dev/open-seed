"""
Advanced memory filters — AND/OR/NOT with comparison operators.
Pattern from: mem0 filter system.

Usage:
    # Simple equality
    filters = {"memory_type": "procedural"}

    # Comparison operators
    filters = {"score": {"$gt": 0.8}}

    # Boolean operators
    filters = {
        "$and": [
            {"memory_type": "procedural"},
            {"resolved": True},
        ]
    }

    # Nested
    filters = {
        "$or": [
            {"memory_type": "semantic"},
            {"$and": [{"memory_type": "procedural"}, {"resolved": True}]}
        ]
    }

Operators: $eq, $ne, $gt, $gte, $lt, $lte, $in, $nin, $and, $or, $not
"""

from __future__ import annotations

from typing import Any

# ---------------------------------------------------------------------------
# Pure-Python matching (works with every backend)
# ---------------------------------------------------------------------------


def _match_value(actual: Any, condition: Any) -> bool:
    """Check whether *actual* satisfies *condition*.

    *condition* can be:
    - A plain value  → equality check
    - A dict of operator clauses like {"$gt": 3, "$lte": 10}
    """
    if not isinstance(condition, dict):
        # Plain equality
        return actual == condition

    for op, operand in condition.items():
        if op == "$eq":
            if actual != operand:
                return False
        elif op == "$ne":
            if actual == operand:
                return False
        elif op == "$gt":
            try:
                if not (actual > operand):  # type: ignore[operator]
                    return False
            except TypeError:
                return False
        elif op == "$gte":
            try:
                if not (actual >= operand):  # type: ignore[operator]
                    return False
            except TypeError:
                return False
        elif op == "$lt":
            try:
                if not (actual < operand):  # type: ignore[operator]
                    return False
            except TypeError:
                return False
        elif op == "$lte":
            try:
                if not (actual <= operand):  # type: ignore[operator]
                    return False
            except TypeError:
                return False
        elif op == "$in":
            if not isinstance(operand, (list, tuple, set)):
                return False
            if actual not in operand:
                return False
        elif op == "$nin":
            if not isinstance(operand, (list, tuple, set)):
                return False
            if actual in operand:
                return False
        else:
            # Unknown operator — treat as no-match to be safe
            return False

    return True


def matches_filter(metadata: dict[str, Any], filters: dict[str, Any]) -> bool:
    """Check if a metadata dict matches the given filters.

    Supports:
    - Simple key/value equality: {"key": "value"}
    - Comparison operators on values: {"key": {"$gt": 0.8}}
    - Boolean operators:
        {"$and": [{...}, {...}]}
        {"$or": [{...}, {...}]}
        {"$not": {...}}
    - Arbitrary nesting of the above.
    """
    if not filters:
        return True

    for key, value in filters.items():
        if key == "$and":
            # value must be a list of sub-filter dicts
            if not isinstance(value, list):
                return False
            if not all(matches_filter(metadata, sub) for sub in value):
                return False

        elif key == "$or":
            if not isinstance(value, list):
                return False
            if not any(matches_filter(metadata, sub) for sub in value):
                return False

        elif key == "$not":
            # value is a single sub-filter dict
            if not isinstance(value, dict):
                return False
            if matches_filter(metadata, value):
                return False

        else:
            # Regular field comparison
            actual = metadata.get(key)
            if not _match_value(actual, value):
                return False

    return True


# ---------------------------------------------------------------------------
# SQL WHERE builder for SQLite (json_extract on metadata column)
# ---------------------------------------------------------------------------


def _sql_value_clause(
    field: str,
    condition: Any,
    params: dict[str, Any],
    counter: list[int],
) -> str:
    """Return a SQL fragment for a single field/condition pair.

    Uses SQLite's json_extract() to pull values out of the JSON metadata
    column.  Param names are unique (param_prefix + incrementing counter).
    """
    json_path = f"$.{field}"
    extract = f"json_extract(metadata, '{json_path}')"

    if not isinstance(condition, dict):
        # Plain equality
        p = f"_p{counter[0]}"
        counter[0] += 1
        params[p] = condition
        return f"{extract} = :{p}"

    clauses: list[str] = []
    for op, operand in condition.items():
        p = f"_p{counter[0]}"
        counter[0] += 1

        if op == "$eq":
            params[p] = operand
            clauses.append(f"{extract} = :{p}")
        elif op == "$ne":
            params[p] = operand
            clauses.append(f"{extract} != :{p}")
        elif op == "$gt":
            params[p] = operand
            clauses.append(f"{extract} > :{p}")
        elif op == "$gte":
            params[p] = operand
            clauses.append(f"{extract} >= :{p}")
        elif op == "$lt":
            params[p] = operand
            clauses.append(f"{extract} < :{p}")
        elif op == "$lte":
            params[p] = operand
            clauses.append(f"{extract} <= :{p}")
        elif op == "$in":
            if not isinstance(operand, (list, tuple)):
                clauses.append("0")  # always false
            else:
                placeholders = []
                for v in operand:
                    pp = f"_p{counter[0]}"
                    counter[0] += 1
                    params[pp] = v
                    placeholders.append(f":{pp}")
                clauses.append(f"{extract} IN ({', '.join(placeholders)})")
        elif op == "$nin":
            if not isinstance(operand, (list, tuple)):
                pass  # no constraint
            else:
                placeholders = []
                for v in operand:
                    pp = f"_p{counter[0]}"
                    counter[0] += 1
                    params[pp] = v
                    placeholders.append(f":{pp}")
                clauses.append(f"{extract} NOT IN ({', '.join(placeholders)})")
        else:
            clauses.append("0")  # unknown op → always false

    return " AND ".join(clauses) if clauses else "1"


def _build_sql_clause(
    filters: dict[str, Any],
    params: dict[str, Any],
    counter: list[int],
) -> str:
    """Recursively build a SQL clause fragment for *filters*."""
    parts: list[str] = []

    for key, value in filters.items():
        if key == "$and":
            if not isinstance(value, list):
                parts.append("0")
                continue
            sub_parts = [_build_sql_clause(sub, params, counter) for sub in value]
            combined = " AND ".join(f"({s})" for s in sub_parts)
            parts.append(f"({combined})")

        elif key == "$or":
            if not isinstance(value, list):
                parts.append("0")
                continue
            sub_parts = [_build_sql_clause(sub, params, counter) for sub in value]
            combined = " OR ".join(f"({s})" for s in sub_parts)
            parts.append(f"({combined})")

        elif key == "$not":
            if not isinstance(value, dict):
                parts.append("0")
                continue
            inner = _build_sql_clause(value, params, counter)
            parts.append(f"(NOT ({inner}))")

        else:
            parts.append(_sql_value_clause(key, value, params, counter))

    if not parts:
        return "1"
    return " AND ".join(parts)


def build_sql_where(
    filters: dict[str, Any],
    param_prefix: str = "f",  # kept for API compatibility; prefix is now _p + counter
) -> tuple[str, dict[str, Any]]:
    """Convert filters to a SQL WHERE clause fragment and named params.

    Returns:
        (sql_fragment, params_dict)

    The SQL fragment can be embedded directly in a WHERE clause:
        sql = f"SELECT ... FROM memories WHERE user_id = :uid AND ({fragment})"
        conn.execute(sql, {"uid": user_id, **params})

    The fragment uses SQLite's json_extract() to read from the ``metadata``
    JSON column.  Returns ("1", {}) for empty filters (always true).
    """
    if not filters:
        return "1", {}

    params: dict[str, Any] = {}
    counter = [0]
    fragment = _build_sql_clause(filters, params, counter)
    return fragment, params
