from __future__ import annotations

"""
purpose: Command-line interface for the WF-0 pipeline.
"""

import argparse
import asyncio
from pathlib import Path

import yaml

from workflows.wf0.discovery import discover
from workflows.wf0.pipeline import run
from workflows.wf0.validator import validate_file


def _load_manifest(path: Path) -> list[dict]:
    """
    purpose: Load manifest YAML and return workflow entries.
    @param path: (Path) Path to the manifest YAML file.
    @return: (list[dict]) Workflow entries.
    """
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    workflows = data.get("workflows", [])
    if not isinstance(workflows, list):
        raise ValueError("manifest.yaml must contain a top-level 'workflows' list")
    return workflows


async def _run_batch(
    manifest_path: Path,
    output_dir: Path,
    overwrite: bool,
    limit: int | None,
    offset: int,
) -> int:
    """
    purpose: Run the WF-0 pipeline for each non-skipped manifest entry.
    @param manifest_path: (Path) Path to the manifest YAML file.
    @param output_dir: (Path) Output directory for workflow JSON files.
    @param overwrite: (bool) Whether to overwrite existing workflow files.
    @param limit: (int | None) Max number of workflows to process.
    @param offset: (int) Number of eligible workflows to skip before processing.
    @return: (int) Count of successfully processed workflows.
    """
    entries = _load_manifest(manifest_path)
    success = 0
    processed = 0
    skipped = 0
    for entry in entries:
        if entry.get("skip") is True:
            continue
        if skipped < offset:
            skipped += 1
            continue
        if limit is not None and processed >= limit:
            break
        url = entry.get("source_url")
        if not url:
            print("[wf0] Skipping entry with no source_url")
            continue
        try:
            await run(url, output_dir=output_dir, overwrite=overwrite)
            success += 1
        except Exception as exc:
            print(f"[wf0] Failed {url}: {exc}")
        processed += 1
    return success


def main() -> None:
    """
    purpose: Parse CLI arguments and dispatch WF-0 subcommands.
    @return: (None)
    """
    parser = argparse.ArgumentParser(prog="workflows.wf0")
    subparsers = parser.add_subparsers(dest="command", required=True)

    run_parser = subparsers.add_parser("run", help="Run pipeline for a single URL")
    run_parser.add_argument("url")
    run_parser.add_argument("--output-dir", default="workflows")
    run_parser.add_argument("--overwrite", action="store_true")

    batch_parser = subparsers.add_parser("batch", help="Run pipeline for manifest entries")
    batch_parser.add_argument("--manifest", default="manifest.yaml")
    batch_parser.add_argument("--output-dir", default="workflows")
    batch_parser.add_argument("--overwrite", action="store_true")
    batch_parser.add_argument("--limit", type=int, default=None)
    batch_parser.add_argument("--offset", type=int, default=0)

    discover_parser = subparsers.add_parser("discover", help="Generate manifest from sitemap")
    discover_parser.add_argument("--output", default="manifest.yaml")

    validate_parser = subparsers.add_parser("validate", help="Validate a workflow JSON file")
    validate_parser.add_argument("path")

    args = parser.parse_args()

    if args.command == "run":
        asyncio.run(run(args.url, output_dir=Path(args.output_dir), overwrite=args.overwrite))
    elif args.command == "batch":
        asyncio.run(_run_batch(
            Path(args.manifest),
            Path(args.output_dir),
            args.overwrite,
            args.limit,
            args.offset,
        ))
    elif args.command == "discover":
        count = discover(Path(args.output))
        print(f"[wf0] Discovered {count} articles")
    elif args.command == "validate":
        errors = validate_file(Path(args.path))
        if errors:
            print("Invalid:")
            for error in errors:
                print(f"- {error}")
        else:
            print("Valid")


if __name__ == "__main__":
    main()
