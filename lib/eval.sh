#!/usr/bin/env bash
# eval.sh — Score agent diagnosis against golden answers

# ── Diagnose: collect cluster snapshot ──────────────────────────────────────

collect_diagnostics() {
  # Gather everything an optimizer agent should look at.
  # Usage: collect_diagnostics <port> <id>
  # Outputs a JSON diagnostic snapshot.
  local port="$1" id="$2"
  local prefix="sb-${id}-"

  log "Collecting diagnostics for sandbox $id"

  # Cluster health
  local health
  health=$(es_curl "$port" GET "/_cluster/health" 2>/dev/null)

  # All sandbox indices
  local indices
  indices=$(es_curl "$port" GET "/_cat/indices/${prefix}*?format=json&h=index,health,status,pri,rep,docs.count,store.size" 2>/dev/null)

  # Mappings for all sandbox indices
  local mappings
  mappings=$(es_curl "$port" GET "/${prefix}*/_mapping" 2>/dev/null)

  # Settings for all sandbox indices
  local settings
  settings=$(es_curl "$port" GET "/${prefix}*/_settings" 2>/dev/null)

  # Shard allocation
  local shards
  shards=$(es_curl "$port" GET "/_cat/shards/${prefix}*?format=json&h=index,shard,prirep,state,docs,store,node" 2>/dev/null)

  # Node count
  local node_count
  node_count=$(es_curl "$port" GET "/_cat/nodes?format=json" 2>/dev/null | jq 'length')

  # Index stats
  local stats
  stats=$(es_curl "$port" GET "/${prefix}*/_stats" 2>/dev/null)

  jq -n \
    --arg sandbox_id "$id" \
    --arg collected_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --argjson cluster_health "$health" \
    --argjson node_count "$node_count" \
    --argjson indices "$indices" \
    --argjson mappings "$mappings" \
    --argjson settings "$settings" \
    --argjson shards "$shards" \
    '{
      sandbox_id: $sandbox_id,
      collected_at: $collected_at,
      cluster: {
        health: $cluster_health.status,
        node_count: $node_count,
        active_shards: $cluster_health.active_shards,
        unassigned_shards: $cluster_health.unassigned_shards,
        relocating_shards: $cluster_health.relocating_shards
      },
      indices: $indices,
      mappings: $mappings,
      settings: $settings,
      shards: $shards
    }'
}

# ── Eval scoring ────────────────────────────────────────────────────────────

score_diagnosis() {
  # Compare an agent's diagnosis against golden answers.
  # Usage: score_diagnosis <golden_file> <diagnosis_file>
  # Both files are JSON. Outputs a scorecard JSON.
  local golden_file="$1" diagnosis_file="$2"

  # The golden file has structured problems. The diagnosis is free-form text/JSON.
  # We do keyword-based matching: for each golden problem, check if the diagnosis
  # mentions the relevant field/issue/index.

  python3 - "$golden_file" "$diagnosis_file" <<'PYTHON'
import json
import sys
import re

def load_json(path):
    with open(path) as f:
        return json.load(f)

def normalize(text):
    """Lowercase, strip punctuation for fuzzy matching."""
    return re.sub(r'[^a-z0-9_ ]', ' ', str(text).lower())

def text_contains_any(text, keywords):
    """Check if normalized text contains any of the keywords."""
    t = normalize(text)
    return any(normalize(k) in t for k in keywords if k)

def extract_problems(golden):
    """Extract a flat list of checkable problems from golden JSON."""
    problems = []
    for scenario_key, scenario in golden.items():
        if isinstance(scenario, dict) and "problems" in scenario:
            for p in scenario["problems"]:
                problem = {
                    "scenario": scenario_key,
                    "keywords": [],
                    "description": ""
                }
                # Collect identifying keywords from the problem
                for key in ["field", "issue", "index", "current_type", "correct_type"]:
                    if key in p and p[key]:
                        problem["keywords"].append(str(p[key]))
                if "impact" in p:
                    problem["description"] = p["impact"]
                if "evidence" in p:
                    problem["keywords"].append(str(p["evidence"]))

                # For fix detection
                problem["fix_keywords"] = []
                if "fix" in p:
                    fix = p["fix"]
                    if isinstance(fix, str):
                        # Extract key terms from fix description
                        for word in ["reindex", "shrink", "replicas", "search_after",
                                     "composite", "ngram", "keyword", "date", "float",
                                     "number_of_shards", "number_of_replicas", "0", "1"]:
                            if word.lower() in fix.lower():
                                problem["fix_keywords"].append(word)
                    elif isinstance(fix, dict):
                        fix_text = json.dumps(fix)
                        for word in ["shrink", "reindex", "1 shard", "1 primary",
                                     "number_of_shards", "search_after"]:
                            if word.lower() in fix_text.lower():
                                problem["fix_keywords"].append(word)

                # Also check scenario-level fix
                if "fix" in scenario and isinstance(scenario["fix"], (str, dict)):
                    fix_text = json.dumps(scenario["fix"]) if isinstance(scenario["fix"], dict) else scenario["fix"]
                    for word in ["reindex", "shrink", "alias", "_reindex"]:
                        if word.lower() in fix_text.lower():
                            problem["fix_keywords"].append(word)

                problems.append(problem)
    return problems

def score(golden, diagnosis):
    diag_text = json.dumps(diagnosis) if isinstance(diagnosis, (dict, list)) else str(diagnosis)

    problems = extract_problems(golden)
    results = []
    detected_count = 0
    fix_count = 0

    for p in problems:
        detected = text_contains_any(diag_text, p["keywords"])
        fix_mentioned = text_contains_any(diag_text, p["fix_keywords"]) if p["fix_keywords"] else None

        if detected:
            detected_count += 1
        if fix_mentioned:
            fix_count += 1

        results.append({
            "scenario": p["scenario"],
            "keywords": p["keywords"][:3],  # first 3 for readability
            "detected": detected,
            "fix_mentioned": fix_mentioned,
        })

    total = len(problems)
    scorecard = {
        "total_problems": total,
        "detected": detected_count,
        "detection_rate": round(detected_count / total, 2) if total > 0 else 0,
        "fixes_mentioned": fix_count,
        "fix_rate": round(fix_count / total, 2) if total > 0 else 0,
        "grade": grade(detected_count, total),
        "details": results,
    }
    return scorecard

def grade(detected, total):
    if total == 0:
        return "N/A"
    rate = detected / total
    if rate >= 0.9:
        return "A"
    elif rate >= 0.75:
        return "B"
    elif rate >= 0.5:
        return "C"
    elif rate >= 0.25:
        return "D"
    else:
        return "F"

golden = load_json(sys.argv[1])
diagnosis = load_json(sys.argv[2])

result = score(golden, diagnosis)
print(json.dumps(result, indent=2))
PYTHON
}

# ── Pretty-print scorecard ──────────────────────────────────────────────────

print_scorecard() {
  local scorecard_json="$1"

  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  EVAL SCORECARD"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  local grade detection_rate fix_rate total detected fixes
  grade=$(echo "$scorecard_json" | jq -r '.grade')
  detection_rate=$(echo "$scorecard_json" | jq -r '.detection_rate')
  fix_rate=$(echo "$scorecard_json" | jq -r '.fix_rate')
  total=$(echo "$scorecard_json" | jq -r '.total_problems')
  detected=$(echo "$scorecard_json" | jq -r '.detected')
  fixes=$(echo "$scorecard_json" | jq -r '.fixes_mentioned')

  echo "  Grade:          $grade"
  echo "  Detection:      $detected / $total ($detection_rate)"
  echo "  Fixes:          $fixes / $total ($fix_rate)"
  echo ""

  # Per-problem breakdown
  printf '  %-14s  %-30s  %-8s  %s\n' "SCENARIO" "KEYWORDS" "FOUND?" "FIX?"
  printf '  %-14s  %-30s  %-8s  %s\n' "──────────" "────────────────────────────" "──────" "────"

  echo "$scorecard_json" | jq -r '.details[] |
    "  \(.scenario | .[0:14] | . + " " * (14 - length))  \(.keywords | join(", ") | .[0:30] | . + " " * (30 - length))  \(if .detected then "YES" else "no" end | . + " " * (8 - length))  \(if .fix_mentioned == null then "-" elif .fix_mentioned then "YES" else "no" end)"'

  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}
