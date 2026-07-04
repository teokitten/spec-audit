# OpenAPI Spec Audit

A documentation-quality linter for OpenAPI specs. Paste a spec (JSON or YAML),
fetch one from a URL, or load a sample, and get a scored report of documentation
gaps: missing descriptions, absent examples, undocumented error responses, loose
type constraints, and ambiguous required/optional status.

This is not a spec renderer – Swagger UI, Redoc, and Scalar already do that well.
This tool checks whether a human reader has what they need, not schema
correctness.

## Live tool

[teokitten.github.io/spec-audit](https://teokitten.github.io/spec-audit/)

## How it works

- Paste, fetch by URL, or load a sample OpenAPI 3.0/3.1 spec
- Runs six checks per endpoint: missing/low-quality descriptions, missing
  examples, undocumented error responses, missing type constraints, ambiguous
  required status, and unresolvable $ref references
- Each endpoint gets a weighted score (0–100); checks that block a developer
  outright (missing descriptions, undocumented errors) weigh twice as much as
  checks that just slow them down (missing examples, loose constraints, ambiguous
  required fields)
- Overall grade: A = 90–100, B = 75–89, C = 60–74, D = 40–59, F = 0–39

## Running locally

Single HTML file, no build step, no dependencies except js-yaml (loaded from CDN
for YAML parsing).

```
python3 -m http.server 8000
```

Then open `http://localhost:8000`.

## Built by

[Teo Moldovanu](https://teokitten.github.io)
