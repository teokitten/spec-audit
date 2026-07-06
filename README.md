# OpenAPI Spec Audit

A documentation-quality linter for OpenAPI specs. Paste a spec (JSON or YAML),
fetch one from a URL, or load a sample, and get a scored report of
documentation gaps: missing descriptions, absent examples, undocumented error
responses, loose type constraints, ambiguous required/optional status, and
semantic inconsistencies. It also checks spec-wide consistency: whether the
same field is described the same way everywhere it appears, and whether naming
conventions are used consistently across the spec. Checks are configurable,
reports are exportable (JSON or a standalone HTML snapshot), and you can
compare two reports to track whether a spec is improving or regressing over
time. A CLI is also included for running audits outside the browser, e.g. in
CI.

This is not a spec renderer – Swagger UI, Redoc, and Scalar already do that well.
This tool checks whether a human reader has what they need, not schema
correctness.

## Live tool

[teokitten.github.io/spec-audit](https://teokitten.github.io/spec-audit/)

## How it works

- Paste, fetch by URL, or load a sample OpenAPI 3.0/3.1 spec
- Runs checks per endpoint across two kinds of problems: structural issues
  that always count toward the score (unresolvable $ref references,
  endpoints that couldn't be fully parsed) and editorial checks that can be
  individually enabled or disabled (missing/low-quality descriptions, missing
  examples, undocumented error responses, missing type constraints, ambiguous
  required status, and semantic inconsistencies – type-description mismatches,
  enum-description mismatches, and an off-by-default dangling-field-reference
  check with a high false-positive rate on real-world specs)
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

- Short descriptions: brief but correct text (e.g. "Not Found," 9 characters)
  may still get flagged just for being under 10 characters.
- Field-name mentions: one check looks for field names mentioned in the text.
  It's easily confused by lists of allowed values, and therefore off by default.
- Same word, different meaning: another check looks for a term described
  inconsistently across the spec. Sometimes a word is used for two different
  things on purpose – the tool can't always tell the difference.

## Example specs

The sample specs available in the tool are fetched live from their public
sources, not bundled or redistributed:

- [GitHub REST API](https://github.com/github/rest-api-description) – MIT
  licensed
- [Stripe API](https://github.com/stripe/openapi) – MIT licensed
- [Swagger Petstore](https://petstore3.swagger.io/) – Apache 2.0, the official
  reference spec maintained for testing tools like this one

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

