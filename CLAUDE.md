if you use emojis i'll shut you down immediately. if you're confused about something, ask me questions. if you think you've found a fix to a problem, DOUBLE CHECK that your assumptions are correct and the fix actually works.

Style guide enforcement should be done via pre-commit.  Ensure you run pre-commit run --all-files before adding/commiting changes to git (`uv tool run pre-commit run --all-files`).  The hooks run mypy and ruff (sunny_agent), tsc and prettier (sunny_backend convex/ and scripts/), and prettier, eslint and tsc (sunny_app). If files are modified by the hook, run pre-commit again.

Before deploying or committing any code, or making a migration, first use the /simplify hook to reduce code sprawl, then use the TLM code reviewer agent @"tlm-code-reviewer (agent)" to review code.

Any frontend code should go in sunny_app. Backend code (Convex functions, schema, crons) goes in sunny_backend. The LiveKit voice agent is sunny_agent.

Assume i have two separate terminals in the background running sunny_backend (`npx convex dev`) and sunny_app. don't run the apps as a background process

# styling
No comments in code. This covers .py, .ts, .tsx and .js files: no `#` or `//` or `/* */` comments, no docstrings, no JSDoc/TSDoc, no file header blocks, no `{/* */}` in JSX. Names, types and small well-named helpers carry the meaning; if code needs a comment to be understood, rename or restructure it instead.

No suppression pragmas either (`# type: ignore`, `# noqa`, `eslint-disable`, `@ts-expect-error`, `@ts-ignore`, mypy `ignore_errors` overrides). Fix the type or lint error at its root.

No quick fixes. Code that would need a comment like "for now", "until X", "TODO", "workaround" or "just in case" is not done: find the root cause and fix that. If the right fix is a product decision, ask me instead of guessing.

Contracts and constraints that the code cannot express (external API quirks, byte layouts, ordering rules between services) belong in notes/ (HANDOFF.md, SCHEMA.md, AGENT_RUNTIME.md), not in code.

Run the declauding skill (`/declauding`) on text that AI wrote and that is not code: the AI-written parts of .md files, commit messages and PR descriptions, before committing or posting them. Leave text I wrote, and copied template text such as the LiveKit starter README in sunny_agent, as it is.
