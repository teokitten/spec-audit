// =============================================================================
// SpecAuditEngine — Node module
//
// KEEP IN SYNC WITH index.html: this file is extracted verbatim from the
// SpecAuditEngine IIFE inside the repo root's index.html (the block between
// the "AUDIT ENGINE" and "UI LAYER" comment banners). There is no build step
// or bundler tying the two together — index.html keeps its own inline copy so
// the browser tool has zero dependencies and no build step. Any change to a
// check, weight, category, or scoring rule must be hand-copied to BOTH
// index.html's inline engine and this file, or the CLI and the browser tool
// will silently disagree on how a spec is scored.
//
// Pure spec-parsing, $ref-resolution, and check/scoring logic. No DOM, no
// browser globals — data in, data out.
// =============================================================================
"use strict";

  // ---------------------------------------------------------------------
  // Example specs, fetched at runtime so they never go stale.
  // ---------------------------------------------------------------------
  var EXAMPLES = {
    petstore: "https://petstore3.swagger.io/api/v3/openapi.json",
    github: "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json",
    stripe: "https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json"
  };

  var HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

  // -----------------------------------------------------------------------
  // SCORING WEIGHTS
  // Every check below produces one or more "check instances" of the form
  // { weight, passed }. An endpoint's score is the weighted pass rate:
  //   score = round( sum(weight where passed) / sum(weight) * 100 )
  //
  // Weight of 2 (higher priority – these are the gaps that block a developer
  // outright, not just slow them down):
  //   - operation has no summary/description
  //   - a parameter has no description
  //   - a 2xx-only endpoint has no error responses documented at all
  //   - a documented error response has no usable description
  //
  // Weight of 1 (lower priority – these are quality-of-life gaps):
  //   - missing example on a request body or primary success response
  //   - a string parameter whose name implies a fixed value set has no enum/format/pattern/length limit
  //   - a numeric parameter has no minimum/maximum
  //   - a parameter's `required` flag is left unset
  //   - an unresolvable $ref (can't be checked further, so it's counted once as a gap)
  //
  // The "restates the parameter name" heuristic is informational only: it is
  // reported as an issue but never affects the score, per the instruction to
  // flag-not-fail on a heuristic that can produce false positives.
  // -----------------------------------------------------------------------
  var WEIGHT_HIGH = 2;
  var WEIGHT_LOW = 1;

  var CATEGORY_LABELS = {
    description: "Missing or unhelpful descriptions",
    "low-quality": "Descriptions that just restate the name",
    examples: "Missing examples",
    errors: "Undocumented error responses",
    constraints: "Missing type constraints",
    required: "Ambiguous required status",
    semantic: "Semantic inconsistencies",
    unresolvable: "Unresolvable references",
    "parse-error": "Endpoints that failed to parse"
  };
  var CATEGORY_ORDER = ["description", "errors", "examples", "constraints", "required", "low-quality", "semantic", "unresolvable", "parse-error"];

  // Categories a user can turn off as a single unit. "unresolvable" and
  // "parse-error" are deliberately excluded – they flag structural problems
  // (a broken $ref, an operation that couldn't be parsed at all), not
  // editorial documentation gaps, so they always count regardless of
  // configuration. "semantic" is also excluded from this list: unlike the
  // other categories, it doesn't have one on/off switch – see
  // SEMANTIC_SUBCHECKS below.
  var CONFIGURABLE_CATEGORIES = ["description", "low-quality", "examples", "errors", "constraints", "required"];

  // The "semantic" category bundles three independently-unreliable
  // heuristics (see buildEndpoint), so instead of one toggle for the whole
  // category, each sub-check gets its own – all three still tag their
  // issues under the "semantic" category for reporting, so the breakdown
  // always shows a single summed "Semantic inconsistencies" row regardless
  // of which sub-checks are active. Dangling-field-reference defaults to
  // off: testing against the GitHub REST API spec (1194 endpoints) found it
  // flagged backtick-quoted enum values, OAuth scope names, and
  // markdown-table field names from unrelated response objects as
  // "dangling" almost every time – too high a false-positive rate to enable
  // out of the box, even though it can be useful on specs that don't write
  // descriptions that way.
  var SEMANTIC_SUBCHECKS = [
    { key: "semantic-type-mismatch", label: "Type-description mismatch", defaultEnabled: true },
    { key: "semantic-enum-mismatch", label: "Enum-description mismatch", defaultEnabled: true },
    { key: "semantic-dangling-reference", label: "Dangling field reference", defaultEnabled: false }
  ];
  var SEMANTIC_SUBCHECK_DEFAULTS = {};
  SEMANTIC_SUBCHECKS.forEach(function (s) { SEMANTIC_SUBCHECK_DEFAULTS[s.key] = s.defaultEnabled; });

  // ---------------------------------------------------------------------
  // Small utilities
  // ---------------------------------------------------------------------
  function isMissing(s) {
    return typeof s !== "string" || s.trim().length === 0;
  }

  function isUselessShort(s) {
    return typeof s === "string" && s.trim().length > 0 && s.trim().length < 10;
  }

  function normalize(s) {
    return String(s).toLowerCase().replace(/[_\-\s]+/g, "");
  }

  var FILLER_WORDS = ["the", "a", "an", "id", "value", "of", "for", "to", "this"];

  function restatesName(name, desc) {
    if (!name || !desc) return false;
    var n = normalize(name);
    var words = String(desc).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    var meaningful = words.filter(function (w) { return FILLER_WORDS.indexOf(w) === -1; });
    if (meaningful.length === 0 || meaningful.length > 3) return false;
    var m = normalize(meaningful.join(""));
    if (!m) return false;
    return m === n || n.indexOf(m) !== -1 || m.indexOf(n) !== -1;
  }

  var CONSTRAINABLE_WORDS = ["status", "type", "state", "category", "kind", "mode", "visibility", "sort", "order", "direction", "role", "level", "priority", "scope", "method"];
  var ID_LIKE_NAME = /(^id$|_id$|Id$)/i;

  // Splits a parameter name into whole-word segments (on underscores/hyphens
  // and camelCase boundaries) and checks whether the LAST segment exactly
  // equals one of CONSTRAINABLE_WORDS, singular or plural. This matches
  // "user_type" and "sortOrder" (last segment "type"/"order") but not
  // "reorder" or "prototype" (single token, "order"/"type" only appear as a
  // suffix within it, not as their own whole word) – the previous raw suffix
  // regex matched both cases.
  function isConstrainableName(name) {
    if (!name) return false;
    var segments = String(name)
      .split(/[_\-\s]+/)
      .reduce(function (acc, part) { return acc.concat(part.split(/(?=[A-Z])/)); }, [])
      .map(function (s) { return s.toLowerCase(); })
      .filter(Boolean);
    if (segments.length === 0) return false;
    var last = segments[segments.length - 1];
    if (CONSTRAINABLE_WORDS.indexOf(last) !== -1) return true;
    return last.charAt(last.length - 1) === "s" && CONSTRAINABLE_WORDS.indexOf(last.slice(0, -1)) !== -1;
  }

  // ---------------------------------------------------------------------
  // Semantic heuristics: pattern-matches against description text, not real
  // language understanding. These are intentionally narrow – a missed case
  // is fine, a flood of false positives isn't – so err toward under-flagging
  // the same way the low-quality-description heuristic does.
  // ---------------------------------------------------------------------
  function impliesBoolean(desc) {
    return /true or false/i.test(desc) || /true\/false/i.test(desc) || /\btrue\b.*\bfalse\b/i.test(desc);
  }

  function impliesNumericRange(desc) {
    return /\bbetween\s+\d+\s+and\s+\d+\b/i.test(desc) || /\brange of\b/i.test(desc);
  }

  var DANGLING_TOKEN_MIN_LENGTH = 3;
  var DANGLING_TOKEN_EXCLUDED = ["true", "false", "null", "id", "get", "post", "put", "delete", "patch"];
  var DANGLING_TOKEN_PATTERNS = [/`([a-zA-Z_][a-zA-Z0-9_]*)`/g, /'([a-zA-Z_][a-zA-Z0-9_]*)'/g];

  // Pulls every backtick- or single-quote-wrapped token out of a description
  // that looks like it's naming a field, and returns the ones that don't
  // match any parameter or request/response schema property on this
  // endpoint – a likely stale reference to a renamed or removed field.
  function findDanglingReferences(text, knownNames) {
    if (!text) return [];
    var seen = new Set();
    var results = [];
    DANGLING_TOKEN_PATTERNS.forEach(function (re) {
      var m;
      while ((m = re.exec(text)) !== null) {
        var token = m[1];
        if (token.length < DANGLING_TOKEN_MIN_LENGTH) continue;
        var lower = token.toLowerCase();
        if (DANGLING_TOKEN_EXCLUDED.indexOf(lower) !== -1) continue;
        if (knownNames.has(token) || seen.has(token)) continue;
        seen.add(token);
        results.push(token);
      }
    });
    return results;
  }

  // Top-level property names of a (possibly $ref'd) schema, one level deep
  // only – this is a fuzzy cross-reference check for the dangling-reference
  // heuristic above, not a full schema traversal.
  function schemaPropertyNames(spec, schemaRef) {
    if (!schemaRef) return [];
    var resolved = deref(spec, schemaRef);
    if (!resolved || resolved.__unresolvable || typeof resolved !== "object") return [];
    if (!resolved.properties || typeof resolved.properties !== "object") return [];
    return Object.keys(resolved.properties);
  }

  // ---------------------------------------------------------------------
  // $ref resolution. Follows chained refs (a ref pointing at another ref)
  // with a cycle guard, which covers the common real-world case of specs
  // that reference a shared schema which itself references another one.
  // Returns { __unresolvable: true, ref } if a ref can't be found, rather
  // than throwing, so the caller can report it and move on.
  // ---------------------------------------------------------------------
  function resolveRefPath(spec, ref) {
    if (typeof ref !== "string" || ref.indexOf("#/") !== 0) return undefined;
    var parts = ref.slice(2).split("/").map(function (p) {
      return decodeURIComponent(p.replace(/~1/g, "/").replace(/~0/g, "~"));
    });
    var node = spec;
    for (var i = 0; i < parts.length; i++) {
      if (node == null || typeof node !== "object") return undefined;
      node = node[parts[i]];
    }
    return node;
  }

  function deref(spec, obj) {
    var seen = new Set();
    var cur = obj;
    var guard = 0;
    while (cur && typeof cur === "object" && typeof cur.$ref === "string") {
      if (seen.has(cur.$ref) || guard++ > 20) {
        return { __unresolvable: true, ref: cur.$ref };
      }
      seen.add(cur.$ref);
      var resolved = resolveRefPath(spec, cur.$ref);
      if (resolved === undefined || resolved === null || typeof resolved !== "object") {
        return { __unresolvable: true, ref: cur.$ref };
      }
      cur = resolved;
    }
    return cur;
  }

  function firstContent(content) {
    if (!content || typeof content !== "object") return null;
    var keys = Object.keys(content);
    if (keys.length === 0) return null;
    var preferred = keys.indexOf("application/json") !== -1 ? "application/json" : keys[0];
    return content[preferred];
  }

  var EXAMPLE_SEARCH_MAX_DEPTH = 3;

  // Looks for an example anywhere within a schema: on the schema itself, on
  // any of its properties (recursing one extra level so an example nested in
  // a sub-object is still found), inside array items, or inside allOf/oneOf/
  // anyOf branches. Each nested schema is deref'd first since real specs
  // commonly reuse components via $ref at every one of these levels. Depth is
  // capped (default 3) so a deeply/circularly nested schema can't cause
  // runaway recursion.
  function schemaHasExample(spec, schema, depth) {
    if (!schema || depth <= 0) return false;
    var resolved = deref(spec, schema);
    if (!resolved || resolved.__unresolvable || typeof resolved !== "object") return false;

    if (resolved.example !== undefined) return true;

    if (resolved.properties && typeof resolved.properties === "object") {
      for (var key in resolved.properties) {
        var propSchema = deref(spec, resolved.properties[key]);
        if (!propSchema || propSchema.__unresolvable) continue;
        if (propSchema.example !== undefined) return true;
        if (schemaHasExample(spec, propSchema, depth - 1)) return true;
      }
    }

    if (resolved.type === "array" && resolved.items && schemaHasExample(spec, resolved.items, depth - 1)) {
      return true;
    }

    var composed = [].concat(resolved.allOf || [], resolved.oneOf || [], resolved.anyOf || []);
    for (var i = 0; i < composed.length; i++) {
      if (schemaHasExample(spec, composed[i], depth - 1)) return true;
    }

    return false;
  }

  function hasExample(spec, mediaTypeObj, schema) {
    if (mediaTypeObj && mediaTypeObj.example !== undefined) return true;
    if (mediaTypeObj && mediaTypeObj.examples && Object.keys(mediaTypeObj.examples).length > 0) return true;
    return schemaHasExample(spec, schema, EXAMPLE_SEARCH_MAX_DEPTH);
  }

  // ---------------------------------------------------------------------
  // Parsing
  // ---------------------------------------------------------------------
  // Resolves the YAML parser without ever referencing a bare, possibly-
  // undeclared global: the browser build loads js-yaml from a CDN <script>
  // tag (window.jsyaml); a future Node/CLI build would get it via
  // require("js-yaml"). Checking `typeof` first means this never throws a
  // ReferenceError in either environment, even if neither is available.
  function resolveYamlLib() {
    if (typeof jsyaml !== "undefined") return jsyaml;
    if (typeof require === "function") {
      try {
        return require("js-yaml");
      } catch (e) {
        return null;
      }
    }
    return null;
  }

  function parseSpecText(text) {
    var trimmed = text.trim();
    if (!trimmed) {
      return { error: "Paste a spec, enter a URL, or load an example to get started." };
    }
    var spec;
    try {
      spec = JSON.parse(trimmed);
      return { spec: spec };
    } catch (jsonErr) {
      var yamlLib = resolveYamlLib();
      if (!yamlLib) {
        return { error: "This doesn't look like valid JSON, and no YAML parser is available to try it as YAML. Check for syntax errors and try again." };
      }
      try {
        spec = yamlLib.load(trimmed);
      } catch (yamlErr) {
        return { error: "This doesn't look like valid JSON or YAML. Check for syntax errors (a stray comma, an unclosed bracket, inconsistent indentation) and try again." };
      }
    }
    if (!spec || typeof spec !== "object") {
      return { error: "This doesn't look like valid JSON or YAML. Check for syntax errors and try again." };
    }
    return { spec: spec };
  }

  function validateSpec(spec) {
    if (spec.swagger && !spec.openapi) {
      return "This looks like a Swagger 2.0 document (found a `swagger` field). This tool audits OpenAPI 3.0/3.1 documents – convert the spec to OpenAPI 3.x and try again.";
    }
    if (!spec.paths || typeof spec.paths !== "object" || Object.keys(spec.paths).length === 0) {
      return "This doesn't look like an OpenAPI document – no `paths` field was found.";
    }
    return null;
  }

  // ---------------------------------------------------------------------
  // Parameter merging: path-level shared parameters + operation-level,
  // operation params win on (name, in) collisions, per the OpenAPI spec.
  // ---------------------------------------------------------------------
  function mergeParams(spec, sharedParams, opParams, unresolvedOut) {
    var map = new Map();
    function addAll(arr) {
      if (!Array.isArray(arr)) return;
      for (var i = 0; i < arr.length; i++) {
        var p = deref(spec, arr[i]);
        if (p.__unresolvable) {
          unresolvedOut.push(p.ref);
          continue;
        }
        if (!p.name || !p.in) continue;
        map.set(p.in + ":" + p.name, p);
      }
    }
    addAll(sharedParams);
    addAll(opParams);
    return Array.from(map.values());
  }

  // ---------------------------------------------------------------------
  // Per-endpoint checks
  // ---------------------------------------------------------------------
  function buildEndpoint(spec, pathKey, method, op, sharedParams, enabledCategories) {
    var checks = [];
    var issues = [];
    // A category is active if it's structural (always on) or the caller has
    // it enabled. `enabledCategories` is a Set of configurable category keys;
    // omitting it entirely (e.g. calling the engine without config support)
    // is treated as "everything enabled", for backward compatibility.
    function categoryEnabled(category) {
      if (CONFIGURABLE_CATEGORIES.indexOf(category) === -1) return true;
      return !enabledCategories || enabledCategories.has(category);
    }
    // The three semantic checks are gated individually rather than through
    // categoryEnabled/"semantic" (which isn't in CONFIGURABLE_CATEGORIES
    // any more) – each has its own default, so omitting `enabledCategories`
    // entirely falls back to that check's own default rather than a blanket
    // "everything on".
    function subCheckEnabled(key) {
      if (!enabledCategories) return SEMANTIC_SUBCHECK_DEFAULTS[key];
      return enabledCategories.has(key);
    }
    // Disabling a category removes both its weight and its issue, so the
    // score is recalculated as if that check never ran at all – not just
    // filtered out of the report afterward.
    function addCheck(category, weight, passed) {
      if (!categoryEnabled(category)) return;
      checks.push({ weight: weight, passed: passed });
    }
    function addIssue(category, field, message) {
      if (!categoryEnabled(category)) return;
      issues.push({ category: category, field: field, message: message });
    }

    var unresolved = [];
    var params = mergeParams(spec, sharedParams, op.parameters, unresolved);
    for (var u = 0; u < unresolved.length; u++) {
      addCheck("unresolvable", WEIGHT_LOW, false);
      addIssue("unresolvable", "parameter reference", "A parameter reference (\"" + unresolved[u] + "\") could not be resolved – check components/parameters for a missing or renamed entry. Tooling and readers relying on this reference will break.");
    }

    var label = method.toUpperCase() + " " + pathKey;

    // Field names a description might legitimately reference, for the
    // dangling-field-reference check below: every parameter name on this
    // endpoint, plus request body / primary success response schema
    // properties. Resolved independently and read-only here – the request
    // body and response are resolved again in section 3 below, where their
    // own unresolvable/example checks live; that's a separate concern from
    // just gathering names.
    var knownFieldNames = new Set(params.map(function (pp) { return pp.name; }).filter(Boolean));
    if (op.requestBody) {
      var rbForNames = deref(spec, op.requestBody);
      if (!rbForNames.__unresolvable) {
        var rbMediaForNames = firstContent(rbForNames.content);
        if (rbMediaForNames && rbMediaForNames.schema) {
          schemaPropertyNames(spec, rbMediaForNames.schema).forEach(function (n) { knownFieldNames.add(n); });
        }
      }
    }
    var responseEntriesForNames = op.responses && typeof op.responses === "object" ? Object.entries(op.responses) : [];
    var successEntryForNames = responseEntriesForNames.filter(function (e) { return /^2\d\d$/.test(e[0]); })[0];
    if (successEntryForNames) {
      var sRespForNames = deref(spec, successEntryForNames[1]);
      if (!sRespForNames.__unresolvable) {
        var sMediaForNames = firstContent(sRespForNames.content);
        if (sMediaForNames && sMediaForNames.schema) {
          schemaPropertyNames(spec, sMediaForNames.schema).forEach(function (n) { knownFieldNames.add(n); });
        }
      }
    }

    // 1. Operation description / summary
    var opDesc = op.description || op.summary;
    if (isMissing(opDesc)) {
      addCheck("description", WEIGHT_HIGH, false);
      addIssue("description", label, "This endpoint has no summary or description – a developer scanning the spec has no way to tell what it does without reading the source code.");
    } else if (isUselessShort(opDesc)) {
      addCheck("description", WEIGHT_HIGH, false);
      addIssue("description", label, "The description (\"" + opDesc + "\") is only " + opDesc.trim().length + " characters – too short to explain what the endpoint actually does.");
    } else {
      addCheck("description", WEIGHT_HIGH, true);
    }

    if (subCheckEnabled("semantic-dangling-reference")) {
      findDanglingReferences(opDesc, knownFieldNames).forEach(function (token) {
        addCheck("semantic", WEIGHT_LOW, false);
        addIssue("semantic", label, "The description references `" + token + "` but no parameter or schema property with that name exists on this endpoint – this may be a stale reference to a renamed or removed field.");
      });
    }

    // 2. Parameter descriptions (+ restates-name heuristic, + type constraints, + required ambiguity)
    for (var pi = 0; pi < params.length; pi++) {
      var p = params[pi];
      var pLabel = "parameter `" + p.name + "` (" + p.in + ")";

      if (isMissing(p.description)) {
        addCheck("description", WEIGHT_HIGH, false);
        addIssue("description", pLabel, "No description – a developer calling this endpoint has no explanation of what this parameter controls or what values it accepts.");
      } else if (isUselessShort(p.description)) {
        addCheck("description", WEIGHT_HIGH, false);
        addIssue("description", pLabel, "The description (\"" + p.description + "\") is only " + p.description.trim().length + " characters – too short to be useful, likely just a placeholder.");
      } else {
        addCheck("description", WEIGHT_HIGH, true);
        if (restatesName(p.name, p.description)) {
          addIssue("low-quality", pLabel, "The description (\"" + p.description + "\") just restates the parameter name in words – it adds no information a developer couldn't already guess from the name itself.");
        }
      }

      var schema = p.schema ? deref(spec, p.schema) : null;
      if (schema && schema.__unresolvable) {
        addCheck("unresolvable", WEIGHT_LOW, false);
        addIssue("unresolvable", pLabel, "The parameter's schema reference (\"" + schema.ref + "\") could not be resolved, so its type and constraints can't be checked.");
        schema = null;
      }
      if (schema) {
        if (schema.type === "string" && isConstrainableName(p.name || "")) {
          var constrained = schema.enum || schema.format || schema.pattern || schema.minLength != null || schema.maxLength != null;
          addCheck("constraints", WEIGHT_LOW, !!constrained);
          if (!constrained) {
            addIssue("constraints", pLabel, "This is a free-form string with no enum, format, or length limit, even though the name suggests a fixed set of valid values – a developer will have to guess which strings are actually accepted, or trial-and-error against the API.");
          }
        } else if ((schema.type === "integer" || schema.type === "number") && !ID_LIKE_NAME.test(p.name || "")) {
          var bounded = schema.minimum != null || schema.maximum != null;
          addCheck("constraints", WEIGHT_LOW, bounded);
          if (!bounded) {
            addIssue("constraints", pLabel, "This numeric parameter has no minimum or maximum – a developer won't know the valid range without testing the API directly.");
          }
        }

        // These two are detectors, not binary pass/fail states like the
        // constraints checks above: most parameters simply aren't candidates
        // (wrong type, no enum), so – like the unresolved-reference and
        // dangling-reference checks – a weighted check is only added when a
        // problem is actually found. Adding a "passing" check for every
        // string/boolean parameter regardless of relevance would dilute the
        // score with weight that was never really at risk.
        if (!isMissing(p.description)) {
          if (subCheckEnabled("semantic-type-mismatch")) {
            var impliedType = null;
            if (schema.type === "string" && impliesBoolean(p.description)) {
              impliedType = "boolean";
            } else if (schema.type === "boolean" && impliesNumericRange(p.description)) {
              impliedType = "a numeric range";
            }
            if (impliedType) {
              addCheck("semantic", WEIGHT_LOW, false);
              addIssue("semantic", pLabel, "The description implies a " + impliedType + " but this parameter is typed as " + schema.type + " – this may confuse a developer about what values are actually valid, or indicates the schema and description have drifted out of sync.");
            }
          }

          if (subCheckEnabled("semantic-enum-mismatch") && Array.isArray(schema.enum) && schema.enum.length >= 2) {
            var descLower = p.description.toLowerCase();
            var mentionsEnum = schema.enum.some(function (v) { return descLower.indexOf(String(v).toLowerCase()) !== -1; });
            if (!mentionsEnum) {
              addCheck("semantic", WEIGHT_LOW, false);
              addIssue("semantic", pLabel, "This parameter has a fixed set of valid values (`" + schema.enum.join(", ") + "`) but the description doesn't mention any of them – a developer reading only the description won't know what to actually pass.");
            }
          }
        }
      }

      if (subCheckEnabled("semantic-dangling-reference")) {
        findDanglingReferences(p.description, knownFieldNames).forEach(function (token) {
          addCheck("semantic", WEIGHT_LOW, false);
          addIssue("semantic", pLabel, "The description references `" + token + "` but no parameter or schema property with that name exists on this endpoint – this may be a stale reference to a renamed or removed field.");
        });
      }

      if (p.in !== "path") {
        var hasRequired = typeof p.required === "boolean";
        addCheck("required", WEIGHT_LOW, hasRequired);
        if (!hasRequired) {
          addIssue("required", pLabel, "Whether this parameter is required isn't explicitly stated – a developer has to assume it's optional (the OpenAPI default), which may be wrong and cause failed requests.");
        }
      }
    }

    // 3. Examples: request body + primary success response
    if (op.requestBody) {
      var rb = deref(spec, op.requestBody);
      if (rb.__unresolvable) {
        addCheck("unresolvable", WEIGHT_LOW, false);
        addIssue("unresolvable", "requestBody", "The requestBody reference (\"" + rb.ref + "\") could not be resolved – check components/requestBodies for a missing or renamed entry.");
      } else {
        var rbMedia = firstContent(rb.content);
        if (rbMedia) {
          var rbSchema = rbMedia.schema ? deref(spec, rbMedia.schema) : null;
          if (rbSchema && rbSchema.__unresolvable) {
            addCheck("unresolvable", WEIGHT_LOW, false);
            addIssue("unresolvable", "requestBody schema", "The request body schema reference (\"" + rbSchema.ref + "\") could not be resolved.");
          } else {
            var rbEx = hasExample(spec, rbMedia, rbSchema);
            addCheck("examples", WEIGHT_LOW, rbEx);
            if (!rbEx) {
              addIssue("examples", "requestBody", "The request body has no example payload – a developer has to guess the shape of a valid request instead of copying a working sample.");
            }
          }
        }
      }
    }

    var responseEntries = op.responses && typeof op.responses === "object" ? Object.entries(op.responses) : [];
    var successEntry = responseEntries.filter(function (e) { return /^2\d\d$/.test(e[0]); })[0];
    if (successEntry) {
      var sResp = deref(spec, successEntry[1]);
      if (sResp.__unresolvable) {
        addCheck("unresolvable", WEIGHT_LOW, false);
        addIssue("unresolvable", "response " + successEntry[0], "The " + successEntry[0] + " response reference (\"" + sResp.ref + "\") could not be resolved.");
      } else {
        var sMedia = firstContent(sResp.content);
        if (sMedia) {
          var sSchema = sMedia.schema ? deref(spec, sMedia.schema) : null;
          if (sSchema && sSchema.__unresolvable) {
            addCheck("unresolvable", WEIGHT_LOW, false);
            addIssue("unresolvable", "response " + successEntry[0] + " schema", "The " + successEntry[0] + " response schema reference (\"" + sSchema.ref + "\") could not be resolved.");
          } else {
            var sEx = hasExample(spec, sMedia, sSchema);
            addCheck("examples", WEIGHT_LOW, sEx);
            if (!sEx) {
              addIssue("examples", "response " + successEntry[0], "The " + successEntry[0] + " response has no example – a developer building against this endpoint can't see what a real response actually looks like.");
            }
          }
        }
      }
    }

    // 4. Error responses. `default` counts as documenting the error case,
    // since many specs use it instead of enumerating every 4xx/5xx.
    var has2xx = responseEntries.some(function (e) { return /^2\d\d$/.test(e[0]); });
    var errorEntries = responseEntries.filter(function (e) { return /^[45]\d\d$/.test(e[0]) || e[0] === "default"; });

    if (has2xx) {
      addCheck("errors", WEIGHT_HIGH, errorEntries.length > 0);
      if (errorEntries.length === 0) {
        addIssue("errors", label, "This endpoint documents success responses but no error responses at all – a developer has no idea what happens on bad input, missing auth, a not-found resource, or a server error, or how to handle any of it.");
      }
    }

    for (var ei = 0; ei < errorEntries.length; ei++) {
      var code = errorEntries[ei][0];
      var resp = deref(spec, errorEntries[ei][1]);
      var respLabel = "response " + code;
      if (resp.__unresolvable) {
        addCheck("unresolvable", WEIGHT_HIGH, false);
        addIssue("unresolvable", respLabel, "The " + code + " response reference (\"" + resp.ref + "\") could not be resolved.");
        continue;
      }
      var eMedia = firstContent(resp.content);
      var eSchema = eMedia && eMedia.schema ? deref(spec, eMedia.schema) : null;
      var eSchemaOk = eSchema && !eSchema.__unresolvable;
      var descOk = !isMissing(resp.description) && !isUselessShort(resp.description);
      addCheck("errors", WEIGHT_HIGH, descOk);
      if (!descOk) {
        var bodyNote = eSchemaOk ? "" : " and no schema describing the error body";
        addIssue("errors", respLabel, "This response has no meaningful description of when it occurs" + bodyNote + " – a developer can't tell what triggered it" + (eSchemaOk ? "" : " or how to parse the error body") + ".");
      }
    }

    var totalWeight = checks.reduce(function (s, c) { return s + c.weight; }, 0);
    var earned = checks.reduce(function (s, c) { return s + (c.passed ? c.weight : 0); }, 0);
    var score = totalWeight === 0 ? 100 : Math.round((earned / totalWeight) * 100);

    return { path: pathKey, method: method.toUpperCase(), score: score, issues: issues };
  }

  function extractEndpoints(spec, enabledCategories) {
    var endpoints = [];
    var paths = spec.paths || {};
    var pathKeys = Object.keys(paths);
    for (var pk = 0; pk < pathKeys.length; pk++) {
      var pathKey = pathKeys[pk];
      var pathItemRaw = paths[pathKey];
      if (!pathItemRaw || typeof pathItemRaw !== "object") continue;
      var pathItem = deref(spec, pathItemRaw);
      if (pathItem.__unresolvable) {
        endpoints.push({
          path: pathKey, method: "?", score: 0,
          issues: [{ category: "unresolvable", field: pathKey, message: "This path item's reference (\"" + pathItem.ref + "\") could not be resolved, so none of its operations could be checked." }]
        });
        continue;
      }
      var sharedParams = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];
      for (var mi = 0; mi < HTTP_METHODS.length; mi++) {
        var method = HTTP_METHODS[mi];
        var op = pathItem[method];
        if (!op || typeof op !== "object") continue;
        try {
          endpoints.push(buildEndpoint(spec, pathKey, method, op, sharedParams, enabledCategories));
        } catch (e) {
          endpoints.push({
            path: pathKey, method: method.toUpperCase(), score: 0,
            issues: [{ category: "parse-error", field: method.toUpperCase() + " " + pathKey, message: "This endpoint could not be fully checked due to an unexpected error in its definition (" + e.message + ")." }]
          });
        }
      }
    }
    return endpoints;
  }

  function gradeFor(score) {
    if (score >= 90) return "A";
    if (score >= 75) return "B";
    if (score >= 60) return "C";
    if (score >= 40) return "D";
    return "F";
  }

  // ---------------------------------------------------------------------
  // Aggregation: overall score/grade, total issues, and a per-category tally
  // sorted by count descending. This is the same computation the UI used to
  // do inline inside its render function – moved here so "how a spec is
  // scored" lives entirely in the engine, and rendering only ever displays
  // numbers it's handed.
  // ---------------------------------------------------------------------
  function summarize(endpoints) {
    var overallScore = endpoints.length
      ? Math.round(endpoints.reduce(function (s, e) { return s + e.score; }, 0) / endpoints.length)
      : 0;
    var overallGrade = gradeFor(overallScore);
    var totalIssues = endpoints.reduce(function (s, e) { return s + e.issues.length; }, 0);

    var byCategory = {};
    endpoints.forEach(function (e) {
      e.issues.forEach(function (i) {
        byCategory[i.category] = (byCategory[i.category] || 0) + 1;
      });
    });

    var categoryBreakdown = CATEGORY_ORDER.filter(function (c) { return byCategory[c]; })
      .map(function (c) { return { category: c, label: CATEGORY_LABELS[c] || c, count: byCategory[c] }; })
      .sort(function (a, b) { return b.count - a.count; });

    return {
      overallScore: overallScore,
      overallGrade: overallGrade,
      totalIssues: totalIssues,
      categoryBreakdown: categoryBreakdown
    };
  }

  // ---------------------------------------------------------------------
  // Report comparison (diff/trend view). Both arguments are report objects
  // shaped like this tool's own JSON export – { overallScore, overallGrade,
  // totalIssues, categoryBreakdown, disabledChecks, endpoints }. Pure
  // comparison of two already-computed reports: no re-auditing, no access to
  // the original spec, so it works equally well from a previous session's
  // exported file.
  // ---------------------------------------------------------------------
  function validateExportedReport(obj) {
    if (!obj || typeof obj !== "object") {
      return "This file doesn't look like a spec-audit JSON export.";
    }
    if (typeof obj.overallScore !== "number" || typeof obj.overallGrade !== "string" || !Array.isArray(obj.endpoints)) {
      return "This file doesn't look like a spec-audit JSON export – expected fields (\"overallScore\", \"overallGrade\", \"endpoints\") are missing.";
    }
    return null;
  }

  function categoryCountsFor(issues) {
    var counts = {};
    (issues || []).forEach(function (i) { counts[i.category] = (counts[i.category] || 0) + 1; });
    return counts;
  }

  // Every category that appears on either side, even if only one side has
  // it, since a category going from some issues to zero (or vice versa) is
  // exactly the "appeared/disappeared entirely" case callers need to see.
  function diffCategoryCounts(prevCounts, currCounts) {
    var categories = {};
    Object.keys(prevCounts).forEach(function (c) { categories[c] = true; });
    Object.keys(currCounts).forEach(function (c) { categories[c] = true; });
    var result = [];
    Object.keys(categories).forEach(function (c) {
      var previousCount = prevCounts[c] || 0;
      var currentCount = currCounts[c] || 0;
      if (previousCount !== currentCount) {
        result.push({
          category: c,
          label: CATEGORY_LABELS[c] || c,
          previousCount: previousCount,
          currentCount: currentCount,
          delta: currentCount - previousCount
        });
      }
    });
    return result;
  }

  function diffReports(previous, current) {
    var prevByKey = {};
    previous.endpoints.forEach(function (e) { prevByKey[e.method + " " + e.path] = e; });
    var currByKey = {};
    current.endpoints.forEach(function (e) { currByKey[e.method + " " + e.path] = e; });

    var allKeys = {};
    Object.keys(prevByKey).forEach(function (k) { allKeys[k] = true; });
    Object.keys(currByKey).forEach(function (k) { allKeys[k] = true; });

    var endpoints = Object.keys(allKeys).map(function (key) {
      var prevE = prevByKey[key];
      var currE = currByKey[key];
      if (prevE && currE) {
        var scoreDelta = currE.score - prevE.score;
        var status = scoreDelta > 0 ? "improved" : scoreDelta < 0 ? "regressed" : "unchanged";
        return {
          path: currE.path,
          method: currE.method,
          status: status,
          previousScore: prevE.score,
          currentScore: currE.score,
          scoreDelta: scoreDelta,
          categoryChanges: diffCategoryCounts(categoryCountsFor(prevE.issues), categoryCountsFor(currE.issues))
        };
      }
      if (currE) {
        return { path: currE.path, method: currE.method, status: "new", previousScore: null, currentScore: currE.score, scoreDelta: null, categoryChanges: [] };
      }
      return { path: prevE.path, method: prevE.method, status: "removed", previousScore: prevE.score, currentScore: null, scoreDelta: null, categoryChanges: [] };
    });

    var prevCategoryCounts = {};
    (previous.categoryBreakdown || []).forEach(function (r) { prevCategoryCounts[r.category] = r.count; });
    var currCategoryCounts = {};
    (current.categoryBreakdown || []).forEach(function (r) { currCategoryCounts[r.category] = r.count; });
    var categoryDeltas = CATEGORY_ORDER
      .filter(function (c) { return (prevCategoryCounts[c] || 0) !== 0 || (currCategoryCounts[c] || 0) !== 0; })
      .map(function (c) {
        var previousCount = prevCategoryCounts[c] || 0;
        var currentCount = currCategoryCounts[c] || 0;
        return { category: c, label: CATEGORY_LABELS[c] || c, previousCount: previousCount, currentCount: currentCount, delta: currentCount - previousCount };
      });

    // Compared by the specific check key, not just category: two reports can
    // both have a disabled entry tagged "semantic" while disagreeing on
    // *which* semantic sub-check that was, which is still a real config
    // difference. `d.key` falls back to `d.category` for reports exported
    // before per-check keys existed.
    var prevDisabled = (previous.disabledChecks || []).map(function (d) { return d.key || d.category; }).sort();
    var currDisabled = (current.disabledChecks || []).map(function (d) { return d.key || d.category; }).sort();
    var configDiffers = JSON.stringify(prevDisabled) !== JSON.stringify(currDisabled);

    return {
      previousScore: previous.overallScore,
      currentScore: current.overallScore,
      scoreDelta: current.overallScore - previous.overallScore,
      previousGrade: previous.overallGrade,
      currentGrade: current.overallGrade,
      gradeChanged: previous.overallGrade !== current.overallGrade,
      previousTotalIssues: previous.totalIssues,
      currentTotalIssues: current.totalIssues,
      totalIssuesDelta: current.totalIssues - previous.totalIssues,
      categoryDeltas: categoryDeltas,
      configDiffers: configDiffers,
      previousDisabledChecks: previous.disabledChecks || [],
      currentDisabledChecks: current.disabledChecks || [],
      endpoints: endpoints
    };
  }

  // ---------------------------------------------------------------------
  // Single entry point: raw spec text in, a full audit result or an error
  // out. Internally just composes the granular functions above – the browser
  // UI calls those directly instead (see runAudit in the UI layer) so it can
  // show a status message between the parse and check stages on huge specs,
  // but a future CLI (or any other consumer) only needs this one function.
  // ---------------------------------------------------------------------
  function auditSpec(specText, enabledCategories) {
    var parsed = parseSpecText(specText);
    if (parsed.error) {
      return { error: parsed.error, stage: "parse" };
    }
    var validationError = validateSpec(parsed.spec);
    if (validationError) {
      return { error: validationError, stage: "validate" };
    }
    var endpoints = extractEndpoints(parsed.spec, enabledCategories);
    if (endpoints.length === 0) {
      return {
        error: "No operations (GET, POST, PUT, PATCH, DELETE, etc.) were found under any path in this spec.",
        stage: "extract"
      };
    }
    var summary = summarize(endpoints);
    return {
      endpoints: endpoints,
      overallScore: summary.overallScore,
      overallGrade: summary.overallGrade,
      totalIssues: summary.totalIssues,
      categoryBreakdown: summary.categoryBreakdown
    };
  }


module.exports = {
  EXAMPLES: EXAMPLES,
  HTTP_METHODS: HTTP_METHODS,
  WEIGHT_HIGH: WEIGHT_HIGH,
  WEIGHT_LOW: WEIGHT_LOW,
  CATEGORY_LABELS: CATEGORY_LABELS,
  CATEGORY_ORDER: CATEGORY_ORDER,
  CONFIGURABLE_CATEGORIES: CONFIGURABLE_CATEGORIES,
  SEMANTIC_SUBCHECKS: SEMANTIC_SUBCHECKS,
  parseSpecText: parseSpecText,
  validateSpec: validateSpec,
  extractEndpoints: extractEndpoints,
  gradeFor: gradeFor,
  summarize: summarize,
  validateExportedReport: validateExportedReport,
  diffReports: diffReports,
  auditSpec: auditSpec
};
