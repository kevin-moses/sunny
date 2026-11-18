import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "no_comments.py"


def check(tmp_path: Path, name: str, source: str) -> subprocess.CompletedProcess[str]:
    path = tmp_path / name
    path.write_text(source, encoding="utf-8")
    return subprocess.run(
        [sys.executable, str(SCRIPT), str(path)],
        capture_output=True,
        text=True,
        check=False,
    )


@pytest.mark.parametrize(
    ("source", "line"),
    [
        ("x = 1  # TODO for now\n", 1),
        ("x = 1\n# workaround\n", 2),
        ("import os  # noqa: F401\n", 1),
        ("x: int = 'a'  # type: ignore\n", 1),
        ('def f() -> None:\n    """Docstring."""\n', 2),
        ('"""Module docstring."""\n', 1),
        ("class A:\n    'kept as a note'\n", 2),
    ],
)
def test_flags_comments_docstrings_and_pragmas(
    tmp_path: Path, source: str, line: int
) -> None:
    result = check(tmp_path, "m.py", source)
    assert result.returncode == 1
    assert f"m.py:{line}:" in result.stderr


def test_leaves_hashes_in_strings_alone(tmp_path: Path) -> None:
    source = 'url = "https://x.test/#a"\nfmt = f"#{1}"\nprint(url, fmt)\n...\n'
    result = check(tmp_path, "m.py", source)
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize(
    "config",
    [
        "[tool.mypy]\nignore_errors = true\n",
        '[[tool.mypy.overrides]]\nmodule = ["a"]\nignore_errors = true\n',
    ],
)
def test_flags_mypy_ignore_errors(tmp_path: Path, config: str) -> None:
    result = check(tmp_path, "pyproject.toml", config)
    assert result.returncode == 1
    assert "mypy ignore_errors" in result.stderr


def test_accepts_strict_mypy_config(tmp_path: Path) -> None:
    result = check(tmp_path, "pyproject.toml", "[tool.mypy]\nstrict = true\n")
    assert result.returncode == 0, result.stderr


def test_names_a_file_that_does_not_parse(tmp_path: Path) -> None:
    result = check(tmp_path, "m.py", "x = (\n")
    assert result.returncode == 1
    assert "m.py:1: could not be parsed" in result.stderr
