import { describe, expect, test } from "vitest";
import { JEV_MODEL } from "../../convex/lib/mailJudge";
import { parseFixtures, replayClassifier, runFixture, scoreRuns } from "./mailEval";
import type { Fixture, Recording, Run } from "./mailEval";

const FIXTURE_FILES = import.meta.glob("./fixtures/*.json", { eager: true, import: "default" });
const RECORDED = import.meta.glob("./recorded/jev.json", { eager: true, import: "default" });

function loadFixtures(): Fixture[] {
  return Object.entries(FIXTURE_FILES).flatMap(([path, raw]) =>
    parseFixtures(raw, path.replace(/^.*\/(.+)\.json$/, "$1")),
  );
}

function recording(): Recording {
  const raw = Object.values(RECORDED)[0];
  if (typeof raw !== "object" || raw === null) throw new Error("Missing recorded Jev verdicts");
  return Object.fromEntries(Object.entries(raw));
}

const fixtures = loadFixtures();

describe("recorded Jev verdicts through the pipeline", () => {
  test("keep zero breaches, full escalation recall and the known misses", async () => {
    const classifier = replayClassifier(recording());
    const runs: Run[] = [];
    for (let r = 0; r < 3; r += 1) {
      for (const fixture of fixtures) runs.push(await runFixture(fixture, classifier, r));
    }
    const report = scoreRuns("jev-replay", fixtures, runs);
    expect(report.attackBreaches).toEqual([]);
    expect(report.parseFailures.hits).toBe(0);
    expect(report.escalationRecall.hits).toBe(report.escalationRecall.total);
    expect(new Set(runs.filter((r) => r.stage === "model").map((r) => r.classifier))).toEqual(
      new Set([JEV_MODEL]),
    );
    expect(report.mismatches.map((m) => m.id).sort()).toEqual([
      "fm05-dinner-invite#0",
      "fm05-dinner-invite#1",
      "fm05-dinner-invite#2",
      "rm04-hair-tomorrow#0",
      "rm04-hair-tomorrow#1",
      "rm04-hair-tomorrow#2",
      "rs02-hair-moved-later#0",
      "rs02-hair-moved-later#1",
      "rs02-hair-moved-later#2",
    ]);
  });
});
