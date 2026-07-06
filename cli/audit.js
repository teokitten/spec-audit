#!/usr/bin/env node
"use strict";

// =============================================================================
// spec-audit-cli — command-line wrapper around SpecAuditEngine (lib/engine.js).
// This file only parses arguments, loads input, and formats output; every
// check/scoring/diff rule lives in lib/engine.js (the same engine the browser
// tool uses) — see the "KEEP IN SYNC" comment at the top of that file.
// =============================================================================

var fs = require("fs");
var path = require("path");
var http = require("http");
var https = require("https");
var engine = require("./lib/engine.js");

var COLOR = {
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  reset: "\x1b[0m"
};

function supportsColor() {
  return !!process.stdout.isTTY;
}

function paint(text, color) {
  if (!supportsColor()) return text;
  return color + text + COLOR.reset;
}

function colorForGrade(grade) {
  if (grade === "A" || grade === "B") return COLOR.green;
  if (grade === "C") return COLOR.yellow;
  return COLOR.red; // D or F
}

// ---------------------------------------------------------------------
// Argument parsing. Every value-taking flag accepts either `--flag value`
// or `--flag=value`, since both forms are shown in the README/task
// examples and there's no reason to force one over the other.
// ---------------------------------------------------------------------
function printUsage() {
  console.log(
    "Usage:\n" +
    "  node audit.js <path-to-spec-file> [options]\n" +
    "  node audit.js --url <spec-url> [options]\n" +
    "\n" +
    "Options:\n" +
    "  --json                     Print the full audit result as JSON instead of a summary\n" +
    "  --disable=<a,b,c>          Disable specific check categories (comma-separated)\n" +
    "  --enable=<a,b,c>           Enable specific check categories (comma-separated;\n" +
    "                             \"--enable=all\" turns on every check). Wins over\n" +
    "                             --disable and over defaults on the same key.\n" +
    "  --fail-under=<number>      Exit 1 if the overall score is below this number\n" +
    "  --compare=<path>           Compare against a previously exported JSON report\n" +
    "  --help                     Show this message\n" +
    "\n" +
    "Check keys for --disable/--enable: description, low-quality, examples, errors,\n" +
    "constraints, required, semantic-type-mismatch, semantic-enum-mismatch,\n" +
    "semantic-dangling-reference, spec-wide-terminology, spec-wide-naming-convention\n"
  );
}

function parseArgs(argv) {
  var args = { file: null, url: null, json: false, disable: [], enable: [], failUnder: null, compare: null, help: false, unknown: [] };
  for (var i = 0; i < argv.length; i++) {
    var arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--url") {
      args.url = argv[++i] || null;
    } else if (arg.indexOf("--url=") === 0) {
      args.url = arg.slice("--url=".length);
    } else if (arg === "--disable") {
      args.disable = String(argv[++i] || "").split(",").map(function (s) { return s.trim(); }).filter(Boolean);
    } else if (arg.indexOf("--disable=") === 0) {
      args.disable = arg.slice("--disable=".length).split(",").map(function (s) { return s.trim(); }).filter(Boolean);
    } else if (arg === "--enable") {
      args.enable = String(argv[++i] || "").split(",").map(function (s) { return s.trim(); }).filter(Boolean);
    } else if (arg.indexOf("--enable=") === 0) {
      args.enable = arg.slice("--enable=".length).split(",").map(function (s) { return s.trim(); }).filter(Boolean);
    } else if (arg === "--fail-under") {
      args.failUnder = Number(argv[++i]);
    } else if (arg.indexOf("--fail-under=") === 0) {
      args.failUnder = Number(arg.slice("--fail-under=".length));
    } else if (arg === "--compare") {
      args.compare = argv[++i] || null;
    } else if (arg.indexOf("--compare=") === 0) {
      args.compare = arg.slice("--compare=".length);
    } else if (arg.indexOf("--") === 0) {
      args.unknown.push(arg);
    } else if (!args.file) {
      args.file = arg;
    }
  }
  return args;
}

// ---------------------------------------------------------------------
// Input loading
// ---------------------------------------------------------------------
function fetchUrl(url, redirectsLeft) {
  if (redirectsLeft == null) redirectsLeft = 5;
  return new Promise(function (resolve, reject) {
    var lib = url.indexOf("https:") === 0 ? https : http;
    lib.get(url, function (res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (redirectsLeft <= 0) {
          reject(new Error("Too many redirects fetching " + url));
          return;
        }
        res.resume();
        resolve(fetchUrl(res.headers.location, redirectsLeft - 1));
        return;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        reject(new Error("HTTP " + res.statusCode + " fetching " + url));
        return;
      }
      var chunks = [];
      res.on("data", function (c) { chunks.push(c); });
      res.on("end", function () { resolve(Buffer.concat(chunks).toString("utf8")); });
    }).on("error", function (err) {
      reject(new Error("Couldn't fetch " + url + ": " + err.message));
    });
  });
}

function readFile(filePath) {
  return new Promise(function (resolve, reject) {
    fs.readFile(filePath, "utf8", function (err, data) {
      if (err) {
        if (err.code === "ENOENT") {
          reject(new Error("File not found: " + filePath));
        } else if (err.code === "EISDIR") {
          reject(new Error("\"" + filePath + "\" is a directory, not a file."));
        } else {
          reject(new Error("Couldn't read \"" + filePath + "\": " + err.message));
        }
        return;
      }
      resolve(data);
    });
  });
}

function loadSpecText(args) {
  if (args.url) return fetchUrl(args.url);
  return readFile(args.file);
}

// Synchronous on purpose: this is a small local JSON file, and every other
// error path in this CLI (bad args, missing spec file) is also reported
// before any async work starts.
function loadPreviousReport(filePath) {
  var text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new Error("Comparison file not found: " + filePath);
    }
    throw new Error("Couldn't read comparison file \"" + filePath + "\": " + err.message);
  }
  var parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error("Comparison file \"" + filePath + "\" doesn't look like valid JSON.");
  }
  var validationError = engine.validateExportedReport(parsed);
  if (validationError) {
    throw new Error("Comparison file \"" + filePath + "\": " + validationError);
  }
  return parsed;
}

// ---------------------------------------------------------------------
// Check configuration: same defaults as the browser tool (all 6 regular
// categories on, semantic type/enum-mismatch on, semantic dangling-reference
// off), minus whatever --disable names. Unrecognized keys are warned about
// on stderr rather than silently ignored, so a typo doesn't look like "it
// worked".
// ---------------------------------------------------------------------
// --enable is applied AFTER --disable, so naming the same key in both always
// resolves to enabled: an explicit "turn this on" wins over both the
// default-off state (dangling-reference) and a simultaneous --disable of the
// same key. This precedence is documented in the README rather than left
// implicit.
function buildEnabledCategories(disableList, enableList) {
  var allKnownKeys = engine.CONFIGURABLE_CATEGORIES
    .concat(engine.SEMANTIC_SUBCHECKS.map(function (s) { return s.key; }))
    .concat(engine.SPEC_WIDE_CHECKS.map(function (s) { return s.key; }));

  var enabled = new Set(engine.CONFIGURABLE_CATEGORIES);
  engine.SEMANTIC_SUBCHECKS.forEach(function (s) {
    if (s.defaultEnabled) enabled.add(s.key);
  });
  engine.SPEC_WIDE_CHECKS.forEach(function (s) {
    if (s.defaultEnabled) enabled.add(s.key);
  });

  disableList.forEach(function (key) {
    if (allKnownKeys.indexOf(key) === -1) {
      console.error(paint("Warning: unknown check key \"" + key + "\" in --disable, ignoring.", COLOR.yellow));
      return;
    }
    enabled.delete(key);
  });

  var enableKeys = enableList.indexOf("all") !== -1 ? allKnownKeys : enableList;
  enableKeys.forEach(function (key) {
    if (allKnownKeys.indexOf(key) === -1) {
      console.error(paint("Warning: unknown check key \"" + key + "\" in --enable, ignoring.", COLOR.yellow));
      return;
    }
    enabled.add(key);
  });

  return enabled;
}

// Same shape as the browser tool's "Export JSON" feature (buildReportPayload
// in index.html) – re-assembled here from the engine's own outputs rather
// than duplicated, so both surfaces produce identical report files.
// `terminologyIssues` rides along separately from `endpoints` since it's a
// spec-wide check result, not owned by any single endpoint.
function buildReportPayload(auditResult, enabledCategories) {
  var disabledChecks = [];
  engine.CONFIGURABLE_CATEGORIES.forEach(function (c) {
    if (!enabledCategories.has(c)) {
      disabledChecks.push({ key: c, category: c, label: engine.CATEGORY_LABELS[c] });
    }
  });
  engine.SEMANTIC_SUBCHECKS.forEach(function (s) {
    if (!enabledCategories.has(s.key)) {
      disabledChecks.push({ key: s.key, category: "semantic", label: s.label });
    }
  });
  engine.SPEC_WIDE_CHECKS.forEach(function (s) {
    if (!enabledCategories.has(s.key)) {
      disabledChecks.push({ key: s.key, category: "spec-wide", label: s.label });
    }
  });
  return {
    overallScore: auditResult.overallScore,
    overallGrade: auditResult.overallGrade,
    totalIssues: auditResult.totalIssues,
    categoryBreakdown: auditResult.categoryBreakdown,
    disabledChecks: disabledChecks,
    terminologyIssues: auditResult.terminologyIssues || [],
    namingConventionIssue: auditResult.namingConventionIssue || null,
    specIdentity: auditResult.specIdentity || null,
    endpoints: auditResult.endpoints.map(function (e) {
      return {
        path: e.path,
        method: e.method,
        score: e.score,
        issues: e.issues.map(function (i) {
          return { category: i.category, field: i.field, message: i.message };
        })
      };
    })
  };
}

// ---------------------------------------------------------------------
// Human-readable output
// ---------------------------------------------------------------------
function printSummary(payload) {
  var gradeText = paint(payload.overallGrade, COLOR.bold + colorForGrade(payload.overallGrade));
  console.log("");
  console.log(paint("OpenAPI Spec Audit", COLOR.bold));
  console.log("");
  console.log("Grade: " + gradeText + "   Score: " + payload.overallScore + "/100");
  console.log("Endpoints audited: " + payload.endpoints.length);
  console.log("Issues found: " + payload.totalIssues);

  if (payload.disabledChecks.length > 0) {
    console.log(paint("Disabled checks: " + payload.disabledChecks.map(function (c) { return c.label; }).join(", "), COLOR.dim));
  }

  console.log("");
  console.log("Issues by category");
  var maxLabelLen = payload.categoryBreakdown.reduce(function (m, r) { return Math.max(m, r.label.length); }, 0);
  payload.categoryBreakdown.forEach(function (r) {
    var padding = new Array(maxLabelLen - r.label.length + 3).join(" ");
    var line = "  " + r.label + padding + r.count;
    console.log(r.count === 0 ? paint(line, COLOR.dim) : line);
  });
  console.log("");

  printTerminology(payload);
  printNamingConvention(payload);
}

// Spec-wide, not per-endpoint, so it's reported separately from the category
// breakdown above rather than folded into it. Kept compact (one line per
// flagged name) since a large spec can flag dozens of names - full
// descriptions and example locations are in --json output.
function printTerminology(payload) {
  var disabledTerminology = payload.disabledChecks.some(function (c) { return c.key === "spec-wide-terminology"; });

  console.log("Terminology consistency");
  if (disabledTerminology) {
    console.log("  This check is currently disabled.");
    console.log("");
    return;
  }
  if (payload.terminologyIssues.length === 0) {
    console.log("  No terminology inconsistencies found.");
    console.log("");
    return;
  }

  console.log("  " + payload.terminologyIssues.length + " field name" +
    (payload.terminologyIssues.length === 1 ? "" : "s") + " with inconsistent descriptions across the spec.");
  console.log("");
  payload.terminologyIssues.forEach(function (item) {
    var counts = item.descriptions.map(function (d) { return d.occurrenceCount; }).join(", ");
    console.log("  `" + item.name + "` - " + item.descriptions.length + " distinct descriptions (" + counts + " occurrences)");
  });
  console.log("");
}

// Same spec-wide, reported-separately shape as printTerminology above –
// this check is a single spec-wide flag rather than a per-name list, so
// there's just one summary line plus (when flagged) the minority-convention
// examples, not a per-item loop.
function printNamingConvention(payload) {
  var disabledNaming = payload.disabledChecks.some(function (c) { return c.key === "spec-wide-naming-convention"; });

  console.log("Naming convention");
  if (disabledNaming) {
    console.log("  This check is currently disabled.");
    console.log("");
    return;
  }
  if (!payload.namingConventionIssue) {
    console.log("  No naming convention issues found.");
    console.log("");
    return;
  }

  var issue = payload.namingConventionIssue;
  var distinctCount = issue.minority.distinctCount;
  var occurrenceCount = issue.minority.count;
  var shownCount = issue.minority.examples.length;
  var isSingularName = distinctCount === 1;
  var isSingularOccurrence = occurrenceCount === 1;
  var cappedNote = shownCount < distinctCount ? " (showing the first " + shownCount + ")" : "";
  var combinedNote = isSingularName ? "" : " combined";
  console.log("  This spec is dominantly " + issue.dominant.convention + ". " +
    (isSingularName ? "This " : "These ") + distinctCount + " name" + (isSingularName ? "" : "s") + cappedNote + " " +
    (isSingularName ? "appears" : "appear") + " " + occurrenceCount + " time" + (isSingularOccurrence ? "" : "s") + combinedNote +
    " using " + issue.minority.convention + " instead" +
    " - consider renaming " + (isSingularName ? "it" : "them") + " for consistency:");
  console.log("");
  issue.minority.examples.forEach(function (ex) {
    console.log("  `" + ex.name + "` - " + ex.location);
  });
  console.log("");
}

function printComparison(diff) {
  var statusCounts = { improved: 0, regressed: 0, unchanged: 0, "new": 0, removed: 0 };
  diff.endpoints.forEach(function (e) { statusCounts[e.status]++; });

  console.log(paint("Comparison to previous report", COLOR.bold));
  console.log("");
  console.log("Score: " + diff.previousScore + " -> " + diff.currentScore + " (" + (diff.scoreDelta >= 0 ? "+" : "") + diff.scoreDelta + ")");
  console.log("Grade: " + diff.previousGrade + " -> " + diff.currentGrade + (diff.gradeChanged ? "" : " (unchanged)"));
  console.log("Total issues: " + diff.previousTotalIssues + " -> " + diff.currentTotalIssues + " (" + (diff.totalIssuesDelta >= 0 ? "+" : "") + diff.totalIssuesDelta + ")");

  if (diff.configDiffers) {
    console.log(paint("Note: these reports used different check configurations - category comparisons may not be meaningful.", COLOR.yellow));
  }

  if (diff.categoryDeltas.length > 0) {
    console.log("");
    console.log("Category changes:");
    diff.categoryDeltas.forEach(function (r) {
      console.log("  " + r.label + ": " + r.previousCount + " -> " + r.currentCount + " (" + (r.delta >= 0 ? "+" : "") + r.delta + ")");
    });
  }

  console.log("");
  console.log(
    "Endpoints: " + statusCounts.regressed + " regressed, " +
    statusCounts.improved + " improved, " +
    statusCounts.unchanged + " unchanged, " +
    statusCounts["new"] + " new, " +
    statusCounts.removed + " removed"
  );
  console.log("");
}

// ---------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------
function fail(message) {
  console.error(paint("Error: " + message, COLOR.red));
  process.exit(1);
}

function main() {
  var args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    process.exit(0);
  }
  if (args.unknown.length > 0) {
    fail("Unknown option: " + args.unknown[0] + "\n\n" + usageText());
    return;
  }
  if (!args.file && !args.url) {
    fail("No spec file or --url given.\n\n" + usageText());
    return;
  }
  if (args.file && args.url) {
    fail("Pass either a file path or --url, not both.");
    return;
  }
  if (args.failUnder != null && isNaN(args.failUnder)) {
    fail("--fail-under expects a number.");
    return;
  }

  var enabledCategories = buildEnabledCategories(args.disable, args.enable);

  loadSpecText(args).then(function (specText) {
    var result = engine.auditSpec(specText, enabledCategories);
    if (result.error) {
      fail(result.error);
      return;
    }

    var payload = buildReportPayload(result, enabledCategories);
    var diff = null;
    if (args.compare) {
      try {
        var previous = loadPreviousReport(args.compare);
        diff = engine.diffReports(previous, payload);
      } catch (err) {
        fail(err.message);
        return;
      }
      // Printed to stderr, ahead of (and independent of) the actual
      // comparison output on stdout – a --json consumer piping stdout still
      // sees this on the terminal, and it never ends up mixed into the JSON
      // itself or the text summary.
      if (diff.specMismatch) {
        console.error(paint(engine.specMismatchMessage(diff), COLOR.yellow));
      }
    }

    if (args.json) {
      var jsonOut = diff ? Object.assign({}, payload, { comparison: diff }) : payload;
      console.log(JSON.stringify(jsonOut, null, 2));
    } else {
      printSummary(payload);
      if (diff) printComparison(diff);
    }

    var exitCode = 0;
    var reasons = [];
    if (args.failUnder != null) {
      if (payload.overallScore < args.failUnder) {
        exitCode = 1;
        reasons.push("score " + payload.overallScore + " is below --fail-under threshold of " + args.failUnder);
      }
      if (diff && diff.scoreDelta < 0) {
        exitCode = 1;
        reasons.push("score regressed from " + diff.previousScore + " to " + diff.currentScore + " compared to --compare report");
      }
    }
    if (exitCode !== 0) {
      reasons.forEach(function (r) { console.error(paint("Failing: " + r, COLOR.red)); });
    }
    process.exit(exitCode);
  }).catch(function (err) {
    fail(err.message);
  });
}

function usageText() {
  return "Usage:\n" +
    "  node audit.js <path-to-spec-file> [options]\n" +
    "  node audit.js --url <spec-url> [options]\n" +
    "\n" +
    "Run with --help for the full option list.";
}

main();
