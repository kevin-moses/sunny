import { readFileSync } from "node:fs";
import { findComments } from "./noComments";

const files = process.argv.slice(2);
let found = 0;
for (const file of files) {
  for (const comment of findComments(file, readFileSync(file, "utf8"))) {
    console.error(`${file}:${comment.line}: ${comment.text}`);
    found += 1;
  }
}
if (found > 0) {
  console.error(
    `${found} comment(s) found. Code carries no comments, docstrings or suppression pragmas (CLAUDE.md).`,
  );
  process.exit(1);
}
