# OpenAPI Spec Audit

A documentation-quality linter for OpenAPI specs. Paste a spec (JSON or YAML),
fetch one from a URL, or load a sample, and get a scored report of documentation
gaps: missing descriptions, absent examples, undocumented error responses, loose
type constraints, ambiguous required/optional status, and semantic
inconsistencies. Checks are configurable, reports are exportable (JSON or a
standalone HTML snapshot), and you can compare two reports to track whether a
spec is improving or regressing over time. A CLI is also included for running
audits outside the browser, e.g. in CI.

This is not a spec renderer – Swagger UI, Redoc, and Scalar already do that well.
This tool checks whether a human reader has what they need, not schema
correctness.

## Live tool

[teokitten.github.io/spec-audit](https://teokitten.github.io/spec-audit/)

## How it works

- Paste, fetch by URL, or load a sample OpenAPI 3.0/3.1 spec
- Runs seven checks per endpoint: missing/low-quality descriptions, missing
  examples, undocumented error responses, missing type constraints, ambiguous
  required status, unresolvable $ref references, and semantic inconsistencies
  (type-description mismatches and enum-description mismatches; a
  dangling-field-reference check is available but off by default due to a high
  false-positive rate on real-world specs)
- Each check category can be individually enabled or disabled – disabling a
  category excludes it from scoring entirely, not just from the report
- Each endpoint gets a weighted score (0–100); checks that block a developer
  outright (missing descriptions, undocumented errors) weigh twice as much as
  checks that just slow them down (missing examples, loose constraints,
  ambiguous required fields, semantic issues)
- Overall grade: A = 90–100, B = 75–89, C = 60–74, D = 40–59, F = 0–39
- Export a report as JSON or a standalone HTML snapshot
- Upload a previous JSON export to compare against the current run – see score
  deltas, category changes, and which specific endpoints improved or regressed

## Limitations

- The under-10-character "likely useless" description heuristic can flag short
  but accurate text (e.g. standard HTTP status descriptions like "Not Found")
  alongside genuine placeholder content.
- The dangling-field-reference semantic check has a high false-positive rate on
  specs that use backticks for enum value lists or OAuth scope names in prose –
  off by default for this reason, can be enabled via config or
  `--enable=semantic-dangling-reference` in the CLI.
- The terminology-consistency check can still flag generic property names that
  happen to have few description variants but represent genuinely different
  concepts sharing a name, despite the stoplist and distinct-description cap in
  place to filter out the most common cases.
- All checks are heuristics based on pattern-matching against spec structure and
  text, not true semantic understanding – they're designed to under-flag rather
  than over-flag, but no heuristic is perfect, and results should inform a human
  review, not replace one.

## Running locally

Single HTML file, no build step, no dependencies except js-yaml (loaded from CDN
for YAML parsing).

```
python3 -m http.server 8000
```

Then open `http://localhost:8000`.

## CLI

A command-line version lives in `cli/` for running audits outside the browser,
including in CI. See `cli/README.md` for full usage, including check
configuration flags (`--enable`/`--disable`), JSON output, comparing against a
previous report (`--compare`), and failing a build on a score threshold or
regression (`--fail-under`).

## Built by

[Teo Moldovanu](https://teokitten.github.io)
