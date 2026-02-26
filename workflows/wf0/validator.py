from __future__ import annotations

"""
purpose: Validate workflow JSON against the shared schema.
"""

import json
from pathlib import Path

from jsonschema import Draft7Validator


def _load_schema() -> dict:
    """
    purpose: Load the workflow JSON schema from disk.
    @return: (dict) Parsed schema dictionary.
    """
    schema_path = Path(__file__).parents[2] / "workflows" / "schema.json"
    return json.loads(schema_path.read_text(encoding="utf-8"))


def validate(workflow: dict) -> list[str]:
    """
    purpose: Validate a workflow dict against the schema.
    @param workflow: (dict) Workflow data to validate.
    @return: (list[str]) Error messages, empty if valid.
    """
    schema = _load_schema()
    validator = Draft7Validator(schema)
    errors: list[str] = []
    for error in sorted(validator.iter_errors(workflow), key=lambda e: e.path):
        path = ".".join([str(p) for p in error.path]) or "root"
        errors.append(f"{path}: {error.message}")
    return errors


def validate_file(path: Path) -> list[str]:
    """
    purpose: Validate a workflow JSON file on disk.
    @param path: (Path) Path to the JSON file.
    @return: (list[str]) Error messages, empty if valid.
    """
    workflow = json.loads(path.read_text(encoding="utf-8"))
    return validate(workflow)
