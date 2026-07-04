# spec-audit-cli

A command-line runner for the [OpenAPI Spec Audit](../index.html) tool. Same
engine, same checks, same scoring as the browser version — this just lets you
run it from a terminal or wire it into CI.

This is **not published to npm**. It's a script you clone alongside the rest
of the repo and run locally with Node.

## Install

```sh
cd cli
npm install
```

Requires Node 14+. The only dependency is [`js-yaml`](https://www.npmjs.com/package/js-yaml), for parsing YAML specs (JSON specs need no dependency at all).

## Basic usage

Audit a local file:

```sh
node audit.js openapi.json
```

Audit a spec fetched from a URL:

```sh
node audit.js --url https://petstore3.swagger.io/api/v3/openapi.json
```

Either JSON or YAML is auto-detected from the content — no flag needed.

### Default output

```
OpenAPI Spec Audit

Grade: B   Score: 83/100
Endpoints audited: 1194
Issues found: 2321
Disabled checks: Dangling field reference

Issues by category
  Undocumented error responses             836
  Missing type constraints                 680
  Ambiguous required status                593
  Semantic inconsistencies                 87
  Descriptions that just restate the name  71
  Missing or unhelpful descriptions        54
```

The grade letter is colored (green for A/B, yellow for C, red for D/F) when
stdout is a terminal. Output is plain text with no color codes when piped or
redirected (e.g. `> report.txt` or in most CI logs).

"Disabled checks" only appears when at least one check is off. By default,
all checks are enabled **except** `semantic-dangling-reference` (see
`--disable` below for why).

## Flags

| Flag | Description |
| --- | --- |
| `--url <url>` | Fetch the spec from a URL instead of reading a local file |
| `--json` | Print the full audit result as JSON instead of the summary |
| `--disable=<a,b,c>` | Disable specific check categories (comma-separated) |
| `--enable=<a,b,c>` | Enable specific check categories (comma-separated; `all` enables everything) |
| `--fail-under=<number>` | Exit 1 if the overall score is below this number |
| `--compare=<path>` | Compare against a previously exported JSON report |
| `--help` | Show usage |

### `--json`

Outputs the exact same shape as the browser tool's "Export JSON" button —
`overallScore`, `overallGrade`, `totalIssues`, `categoryBreakdown`,
`disabledChecks`, and the full `endpoints` array with each endpoint's issues.
Useful for piping into `jq`, saving as a report artifact, or feeding into
`--compare` on a later run.

```sh
node audit.js openapi.json --json > report.json
```

```json
{
  "overallScore": 83,
  "overallGrade": "B",
  "totalIssues": 2321,
  "categoryBreakdown": [
    { "category": "errors", "label": "Undocumented error responses", "count": 836 },
    { "category": "constraints", "label": "Missing type constraints", "count": 680 },
    { "category": "required", "label": "Ambiguous required status", "count": 593 },
    { "category": "semantic", "label": "Semantic inconsistencies", "count": 87 },
    { "category": "low-quality", "label": "Descriptions that just restate the name", "count": 71 },
    { "category": "description", "label": "Missing or unhelpful descriptions", "count": 54 }
  ],
  "disabledChecks": [
    { "key": "semantic-dangling-reference", "category": "semantic", "label": "Dangling field reference" }
  ],
  "endpoints": [ ]
}
```

If `--compare` is also given, the JSON output gets one extra top-level key,
`"comparison"`, holding the diff result described below — stdout is still a
single valid JSON document either way, so it's always safe to pipe.

### `--disable` and `--enable`

These give the CLI full parity with the browser tool's "Configure checks"
panel — every check can be switched either direction, using the same keys:

- `description` — missing or unhelpful descriptions
- `low-quality` — descriptions that just restate the name
- `examples` — missing examples
- `errors` — undocumented error responses
- `constraints` — missing type constraints
- `required` — ambiguous required status
- `semantic-type-mismatch` — description implies a different type than the schema
- `semantic-enum-mismatch` — description doesn't mention any of a parameter's enum values
- `semantic-dangling-reference` — description references a field name that doesn't exist on the endpoint

A disabled category is excluded from scoring entirely, not just hidden from
the report — the same behavior as the browser tool.

```sh
node audit.js openapi.json --disable=constraints,required
```

**Defaults** (before any flags are applied) match the browser tool: all 6
regular categories on, `semantic-type-mismatch` and `semantic-enum-mismatch`
on, `semantic-dangling-reference` **off**. Testing that last one against the
GitHub REST API spec (1194 endpoints) found it flagged backtick-quoted enum
values, OAuth scope names, and markdown-table field names from unrelated
response objects as "dangling" almost every time — a false-positive rate too
high to enable out of the box. If it looks useful on your spec, turn it on:

```sh
node audit.js openapi.json --enable=semantic-dangling-reference
```

`--enable=all` is a shorthand for turning on every check, including
dangling-reference:

```sh
node audit.js openapi.json --enable=all
```

**Precedence when a key appears in both `--disable` and `--enable`:**
`--enable` is always applied after `--disable`, so naming the same key in
both resolves to **enabled**. This is the same rule that lets `--enable`
turn on a check that's off by default — an explicit "turn this on" wins over
both the default state and a simultaneous `--disable` of the same key.

```sh
# constraints ends up ENABLED - --enable wins on the shared key
node audit.js openapi.json --disable=constraints --enable=constraints
```

Pass an unrecognized key to either flag and the CLI warns on stderr and
ignores it, rather than silently doing nothing:

```
Warning: unknown check key "typo-category" in --disable, ignoring.
```

### `--fail-under`

Exits 1 if the overall score is below the given number, 0 otherwise.

```sh
node audit.js openapi.json --fail-under=75
```

If `--fail-under` is **not** provided, the CLI always exits 0 regardless of
score — there's no assumed threshold, so it won't silently fail a CI run
because of a cutoff nobody asked for.

### `--compare`

Loads a previously exported JSON report (from either the browser tool's
"Export JSON" button or a prior `node audit.js --json` run — same format) and
prints a diff summary: score/grade/total-issues deltas, per-category deltas,
and a count of regressed/improved/unchanged/new/removed endpoints.

```sh
node audit.js openapi.json --compare=last-week-report.json
```

```
Comparison to previous report

Score: 84 -> 86 (+2)
Grade: B -> B (unchanged)
Total issues: 2234 -> 1554 (-680)

Category changes:
  Missing type constraints: 680 -> 0 (-680)

Endpoints: 17 regressed, 378 improved, 799 unchanged, 0 new, 0 removed
```

If the two reports were produced with different `--disable` configurations,
a note is printed first:

```
Note: these reports used different check configurations - category comparisons may not be meaningful.
```

#### `--compare` + `--fail-under` together

**This is a two-part failure condition — read carefully before wiring it into CI:**

When both flags are given, the CLI exits 1 if **either**:

1. the current score is below the `--fail-under` threshold, **or**
2. the comparison shows a net regression (the current overall score is lower
   than the previous report's score) —

**regardless of which condition triggered it.** A spec can pass the
threshold comfortably and still fail the build if it got worse since the
last report. Conversely, a spec above the threshold that improved (or held
steady) passes.

```sh
node audit.js openapi.json --fail-under=75 --compare=last-week-report.json
```

Example: current score is 83 (comfortably above a `--fail-under=50`
threshold), but the previous report scored 86 — this still exits 1, because
of condition 2:

```
Score: 86 -> 83 (-3)
...
Failing: score regressed from 86 to 83 compared to --compare report
```

If `--compare` is given **without** `--fail-under`, the diff is printed but
never affects the exit code — same "no assumed threshold" rule as above,
extended to regressions: opting into `--compare` alone is for visibility, not
enforcement.

## Error handling

Clear message, exit code 1, no stack trace, for:

- a spec file that doesn't exist
- invalid JSON/YAML
- valid JSON/YAML that isn't an OpenAPI document (including Swagger 2.0 documents, which are explicitly called out)
- a `--compare` file that doesn't exist, isn't valid JSON, or isn't a spec-audit report export

## GitHub Actions example

This is a documentation example for wiring the CLI into a workflow step —
not a published/reusable GitHub Action. That's a separate future phase.

```yaml
name: API spec audit

on: [push, pull_request]

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Install spec-audit-cli
        run: cd cli && npm install
      - name: Audit OpenAPI spec
        run: node cli/audit.js openapi.json --fail-under=75
```

A non-zero exit code from `audit.js` fails this step, which fails the
workflow run — no extra configuration needed. To also compare against a
baseline report checked into the repo (or downloaded from a previous run's
artifacts), add `--compare`:

```yaml
      - name: Audit OpenAPI spec
        run: node cli/audit.js openapi.json --fail-under=75 --compare=baseline-report.json
```

Remember the two-part failure condition described above: this step fails the
build if the score drops below 75 **or** if it's worse than
`baseline-report.json`, whichever happens first.
