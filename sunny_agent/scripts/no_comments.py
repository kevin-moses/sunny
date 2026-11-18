import ast
import io
import sys
import tokenize
import tomllib
from pathlib import Path

SHOWN_CHARS = 80
RULE = "Code carries no comments, docstrings or suppression pragmas (CLAUDE.md)."


def python_findings(source: str) -> list[tuple[int, str]]:
    found = [
        (token.start[0], token.string[:SHOWN_CHARS])
        for token in tokenize.generate_tokens(io.StringIO(source).readline)
        if token.type == tokenize.COMMENT
    ]
    found += [
        (node.lineno, "docstring or bare string statement")
        for node in ast.walk(ast.parse(source))
        if isinstance(node, ast.Expr)
        and isinstance(node.value, ast.Constant)
        and isinstance(node.value.value, str)
    ]
    return sorted(found)


def pyproject_findings(source: str) -> list[tuple[int, str]]:
    mypy = tomllib.loads(source).get("tool", {}).get("mypy", {})
    sections = [mypy, *mypy.get("overrides", [])]
    if any(section.get("ignore_errors") is True for section in sections):
        return [(1, "mypy ignore_errors")]
    return []


def findings(path: Path) -> list[tuple[int, str]]:
    source = path.read_text(encoding="utf-8")
    if path.name == "pyproject.toml":
        return pyproject_findings(source)
    return python_findings(source)


def main(paths: list[str]) -> int:
    found = 0
    for name in paths:
        try:
            results = findings(Path(name))
        except (SyntaxError, tokenize.TokenError, tomllib.TOMLDecodeError) as error:
            results = [(1, f"could not be parsed: {error}")]
        for line, text in results:
            print(f"{name}:{line}: {text}", file=sys.stderr)
            found += 1
    if found:
        print(f"{found} comment(s) found. {RULE}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
