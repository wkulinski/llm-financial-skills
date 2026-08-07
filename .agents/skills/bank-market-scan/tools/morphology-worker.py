#!/usr/bin/env python3
"""Stdio worker for local Morfeusz 2 lemmatization."""

from __future__ import annotations

import argparse
import json
import re
import sys
from typing import Any


TOKEN_RE = re.compile(r"[\wąćęłńóśźżĄĆĘŁŃÓŚŹŻ]+(?:[-’'][\wąćęłńóśźżĄĆĘŁŃÓŚŹŻ]+)*", re.UNICODE)


def emit(value: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(value, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def run_morfeusz(record: dict[str, Any], morfeusz: Any) -> dict[str, Any]:
    text = record.get("text", "")
    tokens = []
    lemmas = []
    for match in TOKEN_RE.finditer(text):
        surface = match.group(0)
        analyses = morfeusz.analyse(surface)
        lemma = surface.lower()
        if analyses:
            # Prefer nominal/adjectival readings for standalone keyword forms.
            # Morfeusz can rank e.g. ``spłata`` as the rare verb ``spłatać``
            # before the noun needed by the financial vocabulary.
            preferred = next(
                (analysis for analysis in analyses if str(analysis[2][2]).split(':', 1)[0] in {'subst', 'adj', 'adv', 'ger', 'inf'}),
                analyses[0],
            )
            lemma = str(preferred[2][1]).lower()
        tokens.append({
            "surface": surface,
            "lemma": lemma,
            "start": match.start(),
            "end": match.end(),
        })
        lemmas.append(lemma)
    return {"id": record["id"], "lemma_text": " ".join(lemmas), "tokens": tokens}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=("morfeusz",), default="morfeusz")
    args = parser.parse_args()

    morfeusz = None
    if args.mode == "morfeusz":
        import morfeusz2

        morfeusz = morfeusz2.Morfeusz()

    for line in sys.stdin:
        if not line.strip():
            continue
        record = json.loads(line)
        try:
            result = run_morfeusz(record, morfeusz)
            emit(result)
        except Exception as error:  # keep one bad document from killing the batch
            emit({"id": record.get("id"), "error": f"{type(error).__name__}: {error}"})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
