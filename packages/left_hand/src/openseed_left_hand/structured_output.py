"""
Structured output — enforce JSON schema on Claude responses.
Uses prompt-based schema enforcement to guide the model.

Usage:
    schema = OutputSchema(
        schema={
            "type": "object",
            "required": ["status", "result"],
            "properties": {
                "status": {"type": "string"},
                "result": {"type": "string"},
            },
        },
        description="Task completion response",
    )

    # Append schema constraint to your prompt:
    prompt = "Analyze this code." + schema.to_prompt_suffix()

    # Validate the response:
    valid, data = validate_output(response.text, schema)
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any


@dataclass
class OutputSchema:
    """JSON schema for structured output."""

    schema: dict[str, Any]
    description: str = ""

    def to_prompt_suffix(self) -> str:
        """Generate a prompt suffix that forces the output format."""
        schema_str = json.dumps(self.schema, indent=2)
        return (
            f"\n\nYou MUST respond with ONLY valid JSON matching this schema:\n"
            f"{schema_str}\n\n"
            f"No text before or after the JSON."
        )


def validate_output(text: str, schema: OutputSchema) -> tuple[bool, Any]:
    """Validate that text matches the expected JSON schema.

    Searches for the outermost JSON object or array in text, then validates
    it against the schema using basic type and required-field checking.

    Returns:
        (valid, parsed_data) — if parsing fails, parsed_data is None.
    """
    # Prefer object over array, but fall back to array if no object found.
    start = text.find("{")
    end = text.rfind("}")
    if start == -1:
        start = text.find("[")
        end = text.rfind("]")
    if start == -1 or end == -1 or end < start:
        return False, None
    try:
        data = json.loads(text[start : end + 1])
        if not _validate_against_schema(data, schema.schema):
            return False, data
        return True, data
    except (json.JSONDecodeError, ValueError):
        return False, None


def _validate_against_schema(data: Any, schema: dict[str, Any]) -> bool:
    """Basic JSON schema validation — type checking and required fields only.

    Does NOT implement the full JSON Schema specification. Covers the common
    subset: type, required, properties, items.
    """
    schema_type = schema.get("type")

    if schema_type == "object":
        if not isinstance(data, dict):
            return False
        required = schema.get("required", [])
        for key in required:
            if key not in data:
                return False
        properties = schema.get("properties", {})
        for key, prop_schema in properties.items():
            if key in data:
                if not _validate_against_schema(data[key], prop_schema):
                    return False
        return True

    if schema_type == "array":
        if not isinstance(data, list):
            return False
        items_schema = schema.get("items", {})
        if items_schema:
            return all(_validate_against_schema(item, items_schema) for item in data)
        return True

    if schema_type == "string":
        return isinstance(data, str)

    if schema_type == "number":
        return isinstance(data, (int, float))

    if schema_type == "integer":
        return isinstance(data, int) and not isinstance(data, bool)

    if schema_type == "boolean":
        return isinstance(data, bool)

    # No type constraint — anything is valid.
    return True
