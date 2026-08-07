## Documentation path map contract
Skills that read/write project documentation use a path map from the **consumer project** `AGENTS.md`.

## Active docs_map
```yaml
docs_map:
    MAIN_DOC: docs/README.md
    MODULE_INDEX_DOC: docs/README.md
    MODULE_DOCS_GLOB: docs/**/*.md
    AGENT_RULES_DOC: AGENTS.md
    COMMIT_MESSAGE_DIR: /tmp/
    HANDOFF_DOC: var/agent/HANDOFF.md
    SKILLS_INDEX_DOC: docs/SKILLS.md
    CACHE_PATH: var/agent/cache/
```

## Role agentów i lifecycle kontekstu

Agent główny odpowiada za rozmowę z użytkownikiem, interpretację issue, kryteria
akceptacji i lifecycle kontekstu projektu. Przy rozpoczęciu sesji agenta
głównego uruchom `$context-refresh`, chyba że aktywny workflow jawnie deleguje
repozytoryjny rekonesans przez `context-scout-hybrid-run.mjs` i zapisuje ważny
manifest kontekstu.

Delegowane subagenty **nie** uruchamiają automatycznie `$context-refresh`.
Otrzymują zwarty handoff/manifest zamiast kopii treści issue lub pełnej
dokumentacji i działają zgodnie z kontraktem swojego promptu. Jedyną delegowaną
rolą, która może wykonać pełny refresh, jest `context-refresher`, gdy agent
główny jawnie ją wybierze.

## Security & Configuration Tips
- Never commit secrets (`GH_TOKEN`, local `.env.local` values).
- Resolve tool entrypoints through `.agents/skills/_shared/scripts/env-load.sh` (`resolve_tool_cmd`) instead of composing paths manually.
- Keep generated cache/state under `CACHE_PATH`/`var/` out of version control.

## Path Safety for Tool Calls
- Use only paths verified to be inside the repository root for repository reads and edits.
- Before reading an unknown path, resolve it with a repository file search; never invent, guess, or use placeholder paths.
- Do not pass wildcard or placeholder characters such as `*`, `?`, or `...` to a file-read operation.
- If a path is malformed or outside the repository, stop and correct the call instead of probing other external paths.
