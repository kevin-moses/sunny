from __future__ import annotations

"""
purpose: Transform scraped Apple Support content into workflow JSON via Haiku.
Generates all schema fields including senior_description — a plain-language one-liner
phrased as a senior would describe their problem rather than how Apple titles the feature.
"""

import json
from pathlib import Path

import anthropic
from dotenv import load_dotenv


def _fill_slots(template: str, slots: dict[str, str]) -> str:
    """
    purpose: Fill template placeholders using manual string replacement.
    @param template: (str) Template with {slot} placeholders.
    @param slots: (dict[str, str]) Slot values keyed by placeholder name.
    @return: (str) Filled template string.
    """
    for key, value in slots.items():
        template = template.replace("{" + key + "}", value)
    return template


def _load_text(path: Path) -> str:
    """
    purpose: Load a UTF-8 text file from disk.
    @param path: (Path) File path to read.
    @return: (str) File contents.
    """
    return path.read_text(encoding="utf-8")


def _parse_json(text: str) -> dict:
    """
    purpose: Parse JSON from the model response, with light cleanup.
    @param text: (str) Raw model response text.
    @return: (dict) Parsed JSON object.
    """
    cleaned = text.strip()
    if cleaned.startswith("```"):
        parts = cleaned.split("```")
        cleaned = parts[1].lstrip("json").strip() if len(parts) > 1 else cleaned
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start != -1 and end != -1 and end > start:
            return json.loads(cleaned[start : end + 1])
        raise


def transform(metadata: dict, content_by_version: dict[str, str]) -> dict:
    """
    purpose: Call Haiku to generate workflow JSON from metadata and content.
    @param metadata: (dict) Metadata dict with id, title, description, source_type, source_urls.
    @param content_by_version: (dict[str, str]) Scraped content keyed by iOS version.
    @return: (dict) Parsed workflow dict.
    """
    load_dotenv()
    repo_root = Path(__file__).parents[2]
    prompt_path = repo_root / "workflows" / "transformer_prompt.md"
    schema_path = repo_root / "workflows" / "schema.json"

    template = _load_text(prompt_path)
    schema = _load_text(schema_path)

    source_urls = ", ".join(metadata.get("source_urls", []))
    slots = {
        "workflow_id": metadata.get("id", ""),
        "workflow_title": metadata.get("title", ""),
        "workflow_description": metadata.get("description", ""),
        "source_urls": source_urls,
        "source_type": metadata.get("source_type", "apple_docs"),
        "ios16_content": content_by_version.get("16", "NOT AVAILABLE"),
        "ios17_content": content_by_version.get("17", "NOT AVAILABLE"),
        "ios18_content": content_by_version.get("18", "NOT AVAILABLE"),
        "ios26_content": content_by_version.get("26", "NOT AVAILABLE"),
        "schema": schema,
    }

    filled_prompt = _fill_slots(template, slots)

    client = anthropic.Anthropic()
    response = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=8192,
        system=filled_prompt,
        messages=[{"role": "user", "content": "Generate the workflow JSON now."}],
    )
    text = response.content[0].text
    return _parse_json(text)
