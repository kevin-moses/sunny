from __future__ import annotations

"""
purpose: Evaluate Haiku's semantic intent handling for workflow triggers and step success.
"""

import argparse
import json
import random
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import anthropic
from dotenv import load_dotenv

DEFAULT_MODEL = "claude-haiku-4-5-20251001"


@dataclass
class TriggerSample:
    """
    purpose: Represent a trigger-intent test case.
    @param utterance: (str) User utterance.
    @param workflow_id: (str) Expected workflow id.
    @param candidates: (list[dict]) Candidate workflows to choose from.
    """

    utterance: str
    workflow_id: str
    candidates: list[dict]


@dataclass
class SuccessSample:
    """
    purpose: Represent a step success-intent test case.
    @param utterance: (str) User utterance.
    @param label: (str) Expected label: success or not_success.
    @param step: (dict) Step context without success indicators.
    """

    utterance: str
    label: str
    step: dict


def _load_workflow_files(workflows_dir: Path) -> list[dict]:
    """
    purpose: Load workflow JSON files from disk.
    @param workflows_dir: (Path) Directory containing workflow JSON files.
    @return: (list[dict]) Parsed workflow dicts.
    """
    workflows: list[dict] = []
    for path in sorted(workflows_dir.glob("*.json")):
        if path.name == "schema.json":
            continue
        data = json.loads(path.read_text(encoding="utf-8"))
        workflows.append(data)
    return workflows


def _strip_intent_fields(workflow: dict) -> dict:
    """
    purpose: Remove triggers and success indicators for evaluation prompts.
    @param workflow: (dict) Workflow dict.
    @return: (dict) Copy without triggers and success_indicators fields.
    """
    stripped = dict(workflow)
    stripped.pop("triggers", None)
    fallback_steps = []
    for step in stripped.get("fallback_steps", []):
        step_copy = dict(step)
        step_copy.pop("success_indicators", None)
        fallback_steps.append(step_copy)
    stripped["fallback_steps"] = fallback_steps
    ios_versions = stripped.get("ios_versions")
    if isinstance(ios_versions, dict):
        stripped_versions: dict[str, list[dict]] = {}
        for version, steps in ios_versions.items():
            cleaned_steps = []
            for step in steps:
                step_copy = dict(step)
                step_copy.pop("success_indicators", None)
                cleaned_steps.append(step_copy)
            stripped_versions[version] = cleaned_steps
        stripped["ios_versions"] = stripped_versions
    return stripped


def _build_trigger_samples(
    workflows: list[dict],
    max_candidates: int,
    samples_per_workflow: int,
    rng: random.Random,
    hard_negatives: bool,
) -> list[TriggerSample]:
    """
    purpose: Build trigger intent test samples from workflow triggers.
    @param workflows: (list[dict]) Workflow dicts.
    @param max_candidates: (int) Number of candidate workflows per prompt.
    @param samples_per_workflow: (int) Max trigger samples per workflow.
    @param rng: (random.Random) RNG for sampling.
    @return: (list[TriggerSample]) Trigger test samples.
    """
    samples: list[TriggerSample] = []
    for workflow in workflows:
        triggers = workflow.get("triggers", [])
        if not triggers:
            continue
        selected = triggers[:]
        rng.shuffle(selected)
        selected = selected[:samples_per_workflow]
        for trigger in selected:
            candidates = [
                {
                    "id": workflow.get("id"),
                    "title": workflow.get("title"),
                    "description": workflow.get("description"),
                }
            ]
            others = [w for w in workflows if w.get("id") != workflow.get("id")]
            if hard_negatives:
                others.sort(key=lambda w: _similarity_score(workflow, w), reverse=True)
            else:
                rng.shuffle(others)
            for other in others[: max_candidates - 1]:
                candidates.append(
                    {
                        "id": other.get("id"),
                        "title": other.get("title"),
                        "description": other.get("description"),
                    }
                )
            rng.shuffle(candidates)
            samples.append(
                TriggerSample(
                    utterance=trigger,
                    workflow_id=workflow.get("id"),
                    candidates=candidates,
                )
            )
    return samples


def _build_success_samples(
    workflows: list[dict],
    samples_per_step: int,
    rng: random.Random,
    hard_negatives: bool,
) -> list[SuccessSample]:
    """
    purpose: Build success-intent test samples from success indicators and issue triggers.
    @param workflows: (list[dict]) Workflow dicts.
    @param samples_per_step: (int) Max samples per step per class.
    @param rng: (random.Random) RNG for sampling.
    @return: (list[SuccessSample]) Success test samples.
    """
    samples: list[SuccessSample] = []
    for workflow in workflows:
        for step in workflow.get("fallback_steps", []):
            positives = step.get("success_indicators", [])
            if positives:
                shuffled = positives[:]
                rng.shuffle(shuffled)
                for utterance in shuffled[:samples_per_step]:
                    samples.append(
                        SuccessSample(
                            utterance=utterance,
                            label="success",
                            step=_strip_step(step),
                        )
                    )
            issues = step.get("common_issues", [])
            negatives: list[str] = []
            for issue in issues:
                negatives.extend(issue.get("trigger", []))
            if hard_negatives:
                negatives.extend(_other_step_success_indicators(workflow, step))
            if negatives:
                rng.shuffle(negatives)
                for utterance in negatives[:samples_per_step]:
                    samples.append(
                        SuccessSample(
                            utterance=utterance,
                            label="not_success",
                            step=_strip_step(step),
                        )
                    )
    return samples


def _strip_step(step: dict) -> dict:
    """
    purpose: Remove success indicators from a step.
    @param step: (dict) Step data.
    @return: (dict) Step without success indicators.
    """
    stripped = dict(step)
    stripped.pop("success_indicators", None)
    return stripped


def _chunks(items: list, size: int) -> Iterable[list]:
    """
    purpose: Yield successive chunks of a list.
    @param items: (list) Items to chunk.
    @param size: (int) Chunk size.
    @return: (Iterable[list]) Chunks of items.
    """
    for i in range(0, len(items), size):
        yield items[i : i + size]


def _text_features(workflow: dict) -> str:
    """
    purpose: Build a comparison string for workflow similarity.
    @param workflow: (dict) Workflow data.
    @return: (str) Normalized text for similarity scoring.
    """
    title = workflow.get("title", "") or ""
    description = workflow.get("description", "") or ""
    return f"{title} {description}".lower()


def _similarity_score(left: dict, right: dict) -> float:
    """
    purpose: Compute a simple token-overlap score between workflows.
    @param left: (dict) Left workflow.
    @param right: (dict) Right workflow.
    @return: (float) Jaccard similarity score.
    """
    left_tokens = set(_text_features(left).split())
    right_tokens = set(_text_features(right).split())
    if not left_tokens or not right_tokens:
        return 0.0
    intersection = left_tokens.intersection(right_tokens)
    union = left_tokens.union(right_tokens)
    return len(intersection) / len(union)


def _other_step_success_indicators(workflow: dict, current_step: dict) -> list[str]:
    """
    purpose: Collect success indicators from other steps as hard negatives.
    @param workflow: (dict) Workflow data.
    @param current_step: (dict) Step being evaluated.
    @return: (list[str]) Success indicators from other steps.
    """
    negatives: list[str] = []
    current_id = current_step.get("step_id")
    for step in workflow.get("fallback_steps", []):
        if step.get("step_id") == current_id:
            continue
        negatives.extend(step.get("success_indicators", []))
    return negatives


def _call_model(client: anthropic.Anthropic, model: str, system: str, user: str) -> str:
    """
    purpose: Call the Anthropic API and return the text response.
    @param client: (anthropic.Anthropic) SDK client.
    @param model: (str) Model name.
    @param system: (str) System prompt.
    @param user: (str) User prompt.
    @return: (str) Model response text.
    """
    response = client.messages.create(
        model=model,
        max_tokens=512,
        system=system,
        messages=[{"role": "user", "content": user}],
    )
    return response.content[0].text.strip()


def _parse_json(text: str) -> dict:
    """
    purpose: Parse JSON from a model response, with light cleanup.
    @param text: (str) Raw model response.
    @return: (dict) Parsed JSON.
    """
    cleaned = text.strip()
    if cleaned.startswith("```"):
        parts = cleaned.split("```")
        cleaned = parts[1].lstrip("json").strip() if len(parts) > 1 else cleaned
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start != -1 and end != -1 and end > start:
        cleaned = cleaned[start : end + 1]
    return json.loads(cleaned)


def _eval_triggers(
    client: anthropic.Anthropic,
    model: str,
    samples: list[TriggerSample],
    batch_size: int,
) -> tuple[int, int]:
    """
    purpose: Evaluate trigger intent matching accuracy.
    @param client: (anthropic.Anthropic) SDK client.
    @param model: (str) Model name.
    @param samples: (list[TriggerSample]) Trigger test samples.
    @param batch_size: (int) Number of samples per evaluation batch.
    @return: (tuple[int, int]) (correct, total)
    """
    system = (
        "You route user requests to the best workflow id. "
        "Only use the provided workflow candidates. "
        "Return JSON: {\"workflow_id\": \"...\"}."
    )
    correct = 0
    total = 0
    for batch in _chunks(samples, batch_size):
        for sample in batch:
            candidates_text = json.dumps(sample.candidates, ensure_ascii=True)
            user = (
                f"User said: {sample.utterance}\n"
                f"Workflow candidates (id, title, description): {candidates_text}\n"
                "Pick the best workflow id."
            )
            response = _call_model(client, model, system, user)
            try:
                parsed = _parse_json(response)
                predicted = parsed.get("workflow_id")
            except Exception:
                predicted = None
            if predicted == sample.workflow_id:
                correct += 1
            total += 1
    return correct, total


def _eval_success(
    client: anthropic.Anthropic,
    model: str,
    samples: list[SuccessSample],
    batch_size: int,
) -> tuple[int, int, int, int]:
    """
    purpose: Evaluate success-intent classification accuracy.
    @param client: (anthropic.Anthropic) SDK client.
    @param model: (str) Model name.
    @param samples: (list[SuccessSample]) Success test samples.
    @param batch_size: (int) Number of samples per evaluation batch.
    @return: (tuple[int, int, int, int]) (tp, fp, tn, fn)
    """
    system = (
        "You judge whether the user's utterance indicates step success. "
        "Return JSON: {\"label\": \"success\"} or {\"label\": \"not_success\"}."
    )
    tp = fp = tn = fn = 0
    for batch in _chunks(samples, batch_size):
        for sample in batch:
            step_text = json.dumps(sample.step, ensure_ascii=True)
            user = (
                f"Step context: {step_text}\n"
                f"User said: {sample.utterance}\n"
                "Does this indicate the step is complete?"
            )
            response = _call_model(client, model, system, user)
            try:
                parsed = _parse_json(response)
                predicted = parsed.get("label")
            except Exception:
                predicted = None
            expected = sample.label
            if predicted == "success" and expected == "success":
                tp += 1
            elif predicted == "success" and expected == "not_success":
                fp += 1
            elif predicted == "not_success" and expected == "not_success":
                tn += 1
            elif predicted == "not_success" and expected == "success":
                fn += 1
            else:
                fn += 1
    return tp, fp, tn, fn


def _score(tp: int, fp: int, tn: int, fn: int) -> dict:
    """
    purpose: Compute accuracy, precision, recall, and f1.
    @param tp: (int) True positives.
    @param fp: (int) False positives.
    @param tn: (int) True negatives.
    @param fn: (int) False negatives.
    @return: (dict) Metric values.
    """
    total = tp + fp + tn + fn
    accuracy = (tp + tn) / total if total else 0.0
    precision = tp / (tp + fp) if (tp + fp) else 0.0
    recall = tp / (tp + fn) if (tp + fn) else 0.0
    f1 = (2 * precision * recall / (precision + recall)) if (precision + recall) else 0.0
    return {
        "accuracy": accuracy,
        "precision": precision,
        "recall": recall,
        "f1": f1,
    }


def main() -> None:
    """
    purpose: Run the evaluation harness for trigger and success intent.
    @return: (None)
    """
    parser = argparse.ArgumentParser(prog="workflows.wf0.eval")
    parser.add_argument("--workflows-dir", default="workflows")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--trigger-candidates", type=int, default=6)
    parser.add_argument("--trigger-samples", type=int, default=5)
    parser.add_argument("--success-samples", type=int, default=3)
    parser.add_argument("--batch-size", type=int, default=1)
    parser.add_argument("--hard-negatives", action="store_true")
    args = parser.parse_args()

    load_dotenv()

    rng = random.Random(args.seed)
    workflows = _load_workflow_files(Path(args.workflows_dir))
    if not workflows:
        raise SystemExit("No workflow JSON files found for evaluation.")

    trigger_samples = _build_trigger_samples(
        workflows=workflows,
        max_candidates=args.trigger_candidates,
        samples_per_workflow=args.trigger_samples,
        rng=rng,
        hard_negatives=args.hard_negatives,
    )
    success_samples = _build_success_samples(
        workflows=workflows,
        samples_per_step=args.success_samples,
        rng=rng,
        hard_negatives=args.hard_negatives,
    )

    client = anthropic.Anthropic()

    if trigger_samples:
        correct, total = _eval_triggers(client, args.model, trigger_samples, args.batch_size)
        trigger_accuracy = correct / total if total else 0.0
        print(f"Trigger accuracy: {correct}/{total} = {trigger_accuracy:.3f}")
    else:
        print("Trigger accuracy: skipped (no triggers found)")

    if success_samples:
        tp, fp, tn, fn = _eval_success(client, args.model, success_samples, args.batch_size)
        metrics = _score(tp, fp, tn, fn)
        print(
            "Success intent metrics: "
            f"accuracy={metrics['accuracy']:.3f} "
            f"precision={metrics['precision']:.3f} "
            f"recall={metrics['recall']:.3f} "
            f"f1={metrics['f1']:.3f}"
        )
    else:
        print("Success intent metrics: skipped (no success indicators found)")


if __name__ == "__main__":
    main()
