#!/usr/bin/env python3
"""Small JSONL adapter for the required Morfeusz 2 dependency.

The worker deliberately fails when Morfeusz 2 is unavailable. The Node
normalizer may use its explicit fixture engine in offline tests, but it never
silently replaces this worker in the production/default path.
"""

import json
import sys


def load_morfeusz():
    try:
        import morfeusz2  # type: ignore
    except Exception as exc:  # pragma: no cover - exercised by CLI failure tests
        print(f"morfeusz2 unavailable: {exc}", file=sys.stderr)
        raise SystemExit(2)
    return morfeusz2


def version_value(module):
    value = getattr(module, "__version__", None)
    if value is None:
        value = "2.1.0"
    return str(value)


def analyze(module, text):
    analyzer = module.Morfeusz()
    analyses = analyzer.analyse(text)
    spans = {}
    for item in analyses:
        if len(item) < 3:
            continue
        start_index, end_index = item[:2]
        if start_index == end_index or (start_index, end_index) in spans:
            continue
        interpretation = item[2]
        # Morfeusz 2 returns (start, end, (orth, lemma, ...)); keep support
        # for the four-field shape used by older adapters without falling
        # back to surface matching.
        if isinstance(interpretation, (tuple, list)) and len(interpretation) >= 2:
            orth, base = interpretation[:2]
        elif len(item) >= 4:
            orth, base = item[2:4]
        else:
            continue
        spans[(start_index, end_index)] = (str(orth), str(base))

    tokens = []
    cursor = 0
    for start_index, end_index in sorted(spans):
        surface, base = spans[(start_index, end_index)]
        start = text.find(surface, cursor)
        if start < 0:
            continue
        end = start + len(surface)
        tokens.append({
            "surface": surface,
            "lemma": base,
            "start": start,
            "end": end,
            "analysis_start": start_index,
            "analysis_end": end_index
        })
        cursor = end
    if not tokens and text:
        print("Morfeusz 2 returned no token offsets", file=sys.stderr)
        raise SystemExit(3)
    return tokens


def main():
    module = load_morfeusz()
    for line in sys.stdin:
        if not line.strip():
            continue
        request = json.loads(line)
        if request.get("action") == "version":
            print(json.dumps({"version": version_value(module)}, ensure_ascii=False))
            return
        if request.get("action") != "analyze" or not isinstance(request.get("text"), str):
            print("invalid Morfeusz 2 worker request", file=sys.stderr)
            raise SystemExit(4)
        print(json.dumps({"version": version_value(module), "tokens": analyze(module, request["text"])}, ensure_ascii=False))
        return
    print("Morfeusz 2 worker received no request", file=sys.stderr)
    raise SystemExit(4)


if __name__ == "__main__":
    main()
