from __future__ import annotations

"""
purpose: Orchestrate the WF-0 scrape -> transform -> validate pipeline.
"""

import json
from pathlib import Path

from workflows.wf0.scraper import scrape
from workflows.wf0.transformer import transform
from workflows.wf0.validator import validate


async def run(url: str, output_dir: Path = Path("workflows"), overwrite: bool = False) -> Path:
    """
    purpose: Run the full WF-0 pipeline for a single Apple Support URL.
    @param url: (str) Apple Support iPhone guide URL.
    @param output_dir: (Path) Output directory for workflow JSON files.
    @param overwrite: (bool) Whether to overwrite existing JSON files.
    Full pipeline for a single URL.
    1. scrape() -- all 4 iOS version URLs, infer metadata
    2. transform() -- Haiku -> workflow dict
    3. validate() -- schema check; raises on errors
    4. Save to output_dir/<id>.json
    Returns saved path.
    @return: (Path) Path to saved workflow JSON.
    """
    print(f"[wf0] Scraping {url}")
    content_by_version, metadata = await scrape(url)

    if all(v == "NOT AVAILABLE" for v in content_by_version.values()):
        raise ValueError(f"No content scraped for any iOS version from {url}")

    print("[wf0] Transforming content via Haiku")
    workflow = transform(metadata, content_by_version)

    print("[wf0] Validating workflow")
    errors = validate(workflow)
    if errors:
        joined = "\n".join([f"- {e}" for e in errors])
        raise ValueError(f"Workflow validation failed:\n{joined}")

    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / f"{workflow.get('id', metadata.get('id', 'workflow'))}.json"
    if output_path.exists() and not overwrite:
        raise FileExistsError(f"Output file exists: {output_path}")

    output_path.write_text(json.dumps(workflow, indent=2, ensure_ascii=True), encoding="utf-8")
    print(f"[wf0] Saved {output_path}")
    return output_path
