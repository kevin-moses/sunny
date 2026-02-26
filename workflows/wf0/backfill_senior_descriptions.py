from __future__ import annotations

"""
purpose: One-time backfill script that adds the `senior_description` field to all existing
workflow JSON files under workflows/*.json that are missing it.

Batches workflows in groups and calls Haiku once per batch to generate plain-language
descriptions in the voice of how a senior would describe their own problem. The field is
inserted in-place after the `description` key in each JSON file, preserving key order for
all other fields.

Run from the repo root:
    cd workflows && uv run python wf0/backfill_senior_descriptions.py
Or:
    python -m workflows.wf0.backfill_senior_descriptions
"""

import json
import sys
from pathlib import Path

import anthropic
from dotenv import load_dotenv

BATCH_SIZE = 20
WORKFLOW_DIR = Path(__file__).parents[1]


def _load_workflows_needing_backfill() -> list[tuple[Path, dict]]:
    """
    purpose: Find workflow JSON files that are missing the senior_description field.
    @return: (list[tuple[Path, dict]]) List of (path, workflow_dict) for files needing update.
    """
    results = []
    for path in sorted(WORKFLOW_DIR.glob("*.json")):
        if path.name == "schema.json":
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            print(f"[skip] Could not parse {path.name}")
            continue
        if "id" not in data or "title" not in data:
            continue
        if "senior_description" not in data:
            results.append((path, data))
    return results


def _generate_batch(
    client: anthropic.Anthropic,
    batch: list[tuple[Path, dict]],
) -> dict[str, str]:
    """
    purpose: Call Haiku with a batch of workflows and return a mapping of id -> senior_description.
    @param client: (anthropic.Anthropic) Anthropic API client.
    @param batch: (list[tuple[Path, dict]]) Batch of (path, workflow_dict) pairs.
    @return: (dict[str, str]) Mapping of workflow id to generated senior_description string.
    """
    items = [
        {
            "id": wf["id"],
            "title": wf["title"],
            "description": wf.get("description", ""),
        }
        for _, wf in batch
    ]

    system_prompt = """You generate plain-language descriptions of iPhone tasks for senior users.

For each workflow, write a single plain-language sentence describing what the task helps the user
accomplish, phrased the way a senior would describe their own problem — not the way Apple titles a feature.

Rules:
- Think about the problem the user is trying to solve, not the technical feature name.
- Use plain words: call, text, photos, turn off, find, share, stop, add, remove.
- Do NOT start with "How to". Write a fragment or short declarative sentence.
- Do NOT use Apple-speak: navigate, configure, utilize, manage, enable, disable.
- Good: "Stop someone from being able to call or text you"
- Good: "Back up your photos so you don't lose them if something happens to your phone"
- Good: "Make the text on your screen bigger and easier to read"
- Bad: "Manage contact blocking settings in Privacy & Security"
- Bad: "Configure display accessibility options"

Return ONLY valid JSON — a single object mapping each workflow id to its senior_description string.
No markdown, no explanation, just the JSON object.

Example output format:
{"workflow_id_one": "Plain language description here", "workflow_id_two": "Another description here"}"""

    user_message = (
        "Generate a senior_description for each of the following workflows:\n\n"
        + json.dumps(items, indent=2)
    )

    response = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=4096,
        system=system_prompt,
        messages=[{"role": "user", "content": user_message}],
    )

    raw = response.content[0].text.strip()
    if raw.startswith("```"):
        parts = raw.split("```")
        raw = parts[1].lstrip("json").strip() if len(parts) > 1 else raw

    return json.loads(raw)


def _insert_senior_description(data: dict, senior_description: str) -> dict:
    """
    purpose: Return a new dict with senior_description inserted right after description,
    preserving the order of all other keys.
    @param data: (dict) Original workflow dict.
    @param senior_description: (str) Generated senior description string.
    @return: (dict) Updated workflow dict with senior_description in position.
    """
    result: dict = {}
    for key, value in data.items():
        result[key] = value
        if key == "description":
            result["senior_description"] = senior_description
    return result


def main() -> None:
    """
    purpose: Entry point — loads all workflows missing senior_description, batches them,
    calls Haiku, and writes updated JSON files back to disk.
    """
    load_dotenv()
    client = anthropic.Anthropic()

    pending = _load_workflows_needing_backfill()
    if not pending:
        print("All workflows already have senior_description. Nothing to do.")
        return

    print(f"Found {len(pending)} workflows needing backfill.")
    total_updated = 0
    total_errors = 0

    for batch_start in range(0, len(pending), BATCH_SIZE):
        batch = pending[batch_start : batch_start + BATCH_SIZE]
        batch_ids = [wf["id"] for _, wf in batch]
        print(
            f"[batch {batch_start // BATCH_SIZE + 1}] Processing {len(batch)} workflows: "
            + ", ".join(batch_ids[:3])
            + ("..." if len(batch) > 3 else "")
        )

        try:
            descriptions = _generate_batch(client, batch)
        except Exception as exc:
            print(f"  [error] Haiku call failed: {exc}")
            total_errors += len(batch)
            continue

        for path, data in batch:
            wf_id = data["id"]
            if wf_id not in descriptions:
                print(f"  [warn] No senior_description returned for {wf_id}, skipping")
                total_errors += 1
                continue

            desc = descriptions[wf_id].strip()
            if not desc:
                print(f"  [warn] Empty senior_description for {wf_id}, skipping")
                total_errors += 1
                continue

            updated = _insert_senior_description(data, desc)
            path.write_text(
                json.dumps(updated, indent=2, ensure_ascii=True), encoding="utf-8"
            )
            print(f"  [ok] {path.name}: \"{desc[:80]}{'...' if len(desc) > 80 else ''}\"")
            total_updated += 1

    print(f"\nDone. Updated: {total_updated}, Errors: {total_errors}")
    if total_errors > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
