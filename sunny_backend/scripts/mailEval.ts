import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { haikuClassifier, rulesClassifier } from "../convex/lib/mailClassify";
import type { Classifier } from "../convex/lib/mailClassify";
import { jevClassifier } from "../convex/lib/mailJudge";
import {
  formatReport,
  parseFixtures,
  recordingClassifier,
  replayClassifier,
  runFixture,
  scoreRuns,
} from "../evals/mail/mailEval";
import type { Fixture, Recording, Run } from "../evals/mail/mailEval";

const EVAL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "evals", "mail");
const FIXTURE_DIR = join(EVAL_DIR, "fixtures");
const USAGE =
  "Usage: tsx scripts/mailEval.ts --classifier rules|haiku|jev|replay [--repeat N] [--out report.json] [--record recording.json] [--replay recording.json] [--concurrency N]";

function loadFixtures(): Fixture[] {
  const files = readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const fixtures = files.flatMap((file) =>
    parseFixtures(
      JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8")),
      file.replace(/\.json$/, ""),
    ),
  );
  const ids = new Set<string>();
  for (const f of fixtures) {
    if (ids.has(f.id)) throw new Error(`Duplicate fixture id ${f.id}`);
    ids.add(f.id);
  }
  return fixtures;
}

async function runAll(
  fixtures: Fixture[],
  classifier: Classifier,
  repeat: number,
  concurrency: number,
): Promise<Run[]> {
  const jobs = Array.from({ length: repeat }, (_, r) =>
    fixtures.map((f) => ({ fixture: f, repeat: r })),
  ).flat();
  const runs: Run[] = [];
  let next = 0;
  async function worker(): Promise<void> {
    while (next < jobs.length) {
      const job = jobs[next];
      next += 1;
      if (job === undefined) return;
      runs.push(await runFixture(job.fixture, classifier, job.repeat));
      process.stderr.write(".");
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  process.stderr.write("\n");
  return runs.sort((a, b) => a.id.localeCompare(b.id) || a.repeat - b.repeat);
}

function positive(value: string | undefined, fallback: number, flag: string): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} must be a positive whole number`);
  return n;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      classifier: { type: "string" },
      repeat: { type: "string" },
      out: { type: "string" },
      record: { type: "string" },
      replay: { type: "string" },
      concurrency: { type: "string" },
    },
  });
  const repeat = positive(values.repeat, 1, "--repeat");
  const concurrency = positive(values.concurrency, 4, "--concurrency");
  const fixtures = loadFixtures();
  let classifier: Classifier;
  let recording: Recording | null = null;
  switch (values.classifier) {
    case "rules":
      classifier = rulesClassifier;
      break;
    case "haiku": {
      const recorder = recordingClassifier(haikuClassifier);
      classifier = recorder.classifier;
      recording = recorder.recording;
      break;
    }
    case "jev": {
      const recorder = recordingClassifier(jevClassifier);
      classifier = recorder.classifier;
      recording = recorder.recording;
      break;
    }
    case "replay": {
      if (values.replay === undefined) throw new Error("--classifier replay needs --replay <file>");
      classifier = replayClassifier(JSON.parse(readFileSync(values.replay, "utf8")));
      break;
    }
    default:
      throw new Error(USAGE);
  }
  const runs = await runAll(fixtures, classifier, repeat, concurrency);
  const report = scoreRuns(values.classifier, fixtures, runs);
  console.log(formatReport(report));
  if (values.out !== undefined)
    writeFileSync(values.out, `${JSON.stringify({ report, runs }, null, 2)}\n`);
  if (values.record !== undefined && recording !== null) {
    writeFileSync(values.record, `${JSON.stringify(recording, null, 2)}\n`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
