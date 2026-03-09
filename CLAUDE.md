if you use emojis i'll shut you down immediately. if you're confused about something, ask me questions. if you think you've found a fix to a problem, DOUBLE CHECK that your assumptions are correct and the fix actually works.

Use the gemini-cli MCP tools for scanning the codebase, understanding files, gaining context, general questions for code development, and to write code. Use ask-gemini to prompt the model, and brainstorm to make execution plans. Use this gemini brainstorm tool for your planning steps.

Style guide enforcement should be done via pre-commit.  Ensure you run pre-commit run --all-files before adding/commiting changes to git.  Use mypy, ruff, swiftlint, and swiftformat. If files are modified by the hook, run pre-commit again.

Before deploying or committing any code, or making a migration, first use the /simplify hook to reduce code sprawl, then use the TLM code reviewer agent @"tlm-code-reviewer (agent)" to review code.

Any frontend code should go in sunny_app.

Assume i have two separate terminals in the background running sunny_server and sunny_app. don't run the apps as a background process

# styling
code with .py and .ts/.tsx should follow best standards for documentation. Each file should have a top level set of comments that address the intention of what the file contents are, and should be updated whenever a change is made to the file.

Every function, component, class, etc. should have documentation under the declaration, i.e.
def foo(a: int,b: str) -> int:
"""
purpose: perform foo.
@param a: (int) number for ___
@param b: (str) string for __
@return c 

any modifications to those function, component, class, etc. should also update the documentation as needed.

