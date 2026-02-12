# ES Diagnostic Endpoints for Optimizer Agent

Endpoints an optimizer agent needs to diagnose and fix the four sandbox scenarios.
Organized by diagnostic task, not API taxonomy.

Legend: **M** = bad-mapping, **S** = over-sharded, **Q** = slow-queries, **R** = bad-replicas

---

## Tier 1 — Must Have (core diagnosis loop)

These are the endpoints the agent would call on every diagnostic pass.
Without these, it can't do its job.

### Cluster overview

| Endpoint | Method | Returns | Scenarios |
|---|---|---|---|
| `/_cluster/health?level=indices` | GET | Status (green/yellow/red), node count, active/unassigned/relocating shards, per-index health | S R |
| `/_cat/indices/{pattern}?v&h=index,health,pri,rep,docs.count,store.size&s=index` | GET | One row per index: shard counts, doc counts, sizes, health color | S R |
| `/_cat/shards/{pattern}?v&h=index,shard,prirep,state,docs,store,node` | GET | Every shard: which node, STARTED/UNASSIGNED, doc count per shard | S R |
| `/_cat/nodes?v&h=name,role,heap.percent,cpu,load_1m,disk.used_percent` | GET | Node resources: heap, CPU, disk — how many data nodes exist | S Q R |

### Mappings & settings

| Endpoint | Method | Returns | Scenarios |
|---|---|---|---|
| `/{index}/_mapping` | GET | Full field type definitions — the primary bad-mapping diagnostic | M |
| `/{index}/_field_caps?fields=*` | GET | Per-field: type, searchable, aggregatable. Cross-index type conflicts. | M |
| `/{index}/_settings?include_defaults=true&flat_settings=true` | GET | Shard count, replica count, slow log thresholds, refresh interval | S Q R |

### Live performance

| Endpoint | Method | Returns | Scenarios |
|---|---|---|---|
| `/{index}/_stats/search,indexing,fielddata,query_cache,segments,store` | GET | Query count/latency, fielddata evictions, segment count, cache hit ratios | M S Q R |
| `/_nodes/stats/indices,jvm,thread_pool` | GET | Per-node: search latency, heap pressure, GC, thread pool queue/rejections | S Q |
| `/_cat/thread_pool/search,write?v&h=node_name,name,active,queue,rejected` | GET | Search/write thread pool saturation | Q |

### Replica diagnostics

| Endpoint | Method | Returns | Scenarios |
|---|---|---|---|
| `/_cluster/allocation/explain` | POST | Why a specific shard is unassigned — the decider that blocked it | R |

---

## Tier 2 — Situational (deeper investigation)

Called when Tier 1 reveals a problem and the agent needs to drill down.

### Query analysis

| Endpoint | Method | Returns | Scenarios |
|---|---|---|---|
| `/{index}/_search` with `"profile": true` | POST | Per-shard query breakdown: time per clause, rewrite time, collector time | Q |
| `/{index}/_validate/query?explain=true&rewrite=true` | POST | Whether a query is valid, the rewritten Lucene query (reveals wildcard expansion) | M Q |
| `/_tasks?detailed=true&actions=*search*` | GET | Currently running search tasks with durations and actual query bodies | Q |
| `/{index}/_analyze` with `{"field":"x","text":"sample"}` | POST | How a field's analyzer tokenizes text — diagnoses wrong analyzer/type | M |

### Shard & segment detail

| Endpoint | Method | Returns | Scenarios |
|---|---|---|---|
| `/_cat/segments/{index}?v&s=size:desc` | GET | Per-segment: doc count, size, deleted docs — many tiny segments = over-sharded | S |
| `/_cat/allocation?v` | GET | Per-node shard count and disk usage | S R |
| `/{index}/_shard_stores?status=red,yellow` | GET | Shard store exceptions preventing allocation | R |
| `/_cat/recovery?v&active_only=true` | GET | Active shard recoveries — replica rebalancing in progress | R |

### Fielddata & memory

| Endpoint | Method | Returns | Scenarios |
|---|---|---|---|
| `/_cat/fielddata?v&s=size:desc` | GET | Per-field heap usage — text fields in fielddata = mapping problem | M Q |
| `/_nodes/stats/breaker` | GET | Circuit breaker trip counts — fielddata breaker trips = wrong types | M Q |

### Slow log settings (focused)

| Endpoint | Method | Returns | Scenarios |
|---|---|---|---|
| `/_all/_settings?filter_path=*.settings.index.*.slowlog` | GET | Slow log thresholds for every index in one call | Q |

---

## Tier 3 — Context & Templates

Useful for understanding why things are configured the way they are.

| Endpoint | Method | Returns | Scenarios |
|---|---|---|---|
| `/_index_template` | GET | Templates that control default mappings/settings for new indices | M S R |
| `/_component_template` | GET | Reusable template fragments | M S R |
| `/_index_template/_simulate_index/{name}` | POST | What effective template would apply to a new index with this name | M S R |
| `/_ilm/policy` | GET | ILM lifecycle: rollover conditions (shard proliferation), replica changes per phase | S R |
| `/{index}/_ilm/explain` | GET | Current ILM phase/step per index — stuck rollover, wrong phase | S R |
| `/_data_stream` | GET | Backing indices, generation, template — shard multiplication from data streams | S |
| `/_cluster/settings?include_defaults=true` | GET | Cluster-level allocation rules, max_shards_per_node | S R |
| `/_cat/nodeattrs?v` | GET | Node attributes for allocation awareness (rack, zone) | R |

---

## Tier 4 — Expensive / Rarely Needed

Only call when investigating a very specific issue.

| Endpoint | Method | Returns | Scenarios |
|---|---|---|---|
| `/{index}/_disk_usage?run_expensive_tasks=true` | POST | Per-field disk breakdown (inverted index, doc values, norms) | M |
| `/_nodes/hot_threads` | GET | JVM thread dumps — what's actually burning CPU | Q |
| `/_cluster/state/metadata/{index}` | GET | Full cluster state for an index — very large, use sparingly | M S R |
| `/_nodes/usage` | GET | REST action counts per node — reveals client query patterns | Q |

---

## Fix Endpoints (write operations)

These are what the agent would call to actually fix problems, not just diagnose.

| Endpoint | Method | What it fixes | Scenarios |
|---|---|---|---|
| `/{index}/_settings` | PUT | Change replica count, slow log thresholds, refresh interval | Q R |
| `/_reindex` | POST | Copy data to a new index with correct mappings | M |
| `/{index}/_shrink/{target}` | POST | Reduce shard count (requires read-only + single allocation) | S |
| `/{index}/_split/{target}` | POST | Increase shard count if under-sharded | S |
| `/{index}/_forcemerge?max_num_segments=1` | POST | Merge segments after shrink/reindex | S |
| `/{index}/_alias/{alias}` / `/_aliases` | POST | Swap aliases after reindex (zero-downtime migration) | M S |
| `/_cluster/settings` | PUT | Change cluster-level allocation rules, max_shards_per_node | S R |
| `/_tasks/{task_id}/_cancel` | POST | Kill runaway queries | Q |

---

## What to surface as MCP tools

Not every endpoint deserves its own tool. Group them by diagnostic intent:

### Read tools (diagnosis)

| MCP Tool | Wraps | Purpose |
|---|---|---|
| `cluster_health` | `_cluster/health?level=indices` | Overall cluster state — first thing to check |
| `index_info` | `_cat/indices` + `_cat/count` | Index inventory with doc counts and sizes |
| `shard_info` | `_cat/shards` | Shard-level view: state, node placement, per-shard doc counts |
| `index_mapping` | `{index}/_mapping` | Field type definitions (already built-in as `platform.core.get_index_mapping`) |
| `field_caps` | `{index}/_field_caps?fields=*` | Cross-index type conflicts, searchable/aggregatable flags |
| `index_settings` | `{index}/_settings?include_defaults=true&flat_settings=true` | Shard count, replica count, slow log thresholds |
| `index_stats` | `{index}/_stats` | Search latency, fielddata, query cache, segment counts |
| `node_stats` | `_nodes/stats/indices,jvm,thread_pool` | Per-node performance: heap, GC, thread pool saturation |
| `allocation_explain` | `_cluster/allocation/explain` | Why a shard can't be allocated |
| `query_profile` | `{index}/_search` with `profile:true` | Per-clause query timing breakdown |
| `running_tasks` | `_tasks?detailed=true&actions=*search*` | Currently executing search queries |

### Write tools (fixes)

| MCP Tool | Wraps | Purpose |
|---|---|---|
| `update_index_settings` | PUT `{index}/_settings` | Change replicas, slow log thresholds |
| `reindex` | POST `_reindex` | Copy data with new mappings |
| `shrink_index` | POST `{index}/_shrink/{target}` | Reduce shard count |
| `manage_aliases` | POST `_aliases` | Swap aliases for zero-downtime reindex |
| `cancel_task` | POST `_tasks/{id}/_cancel` | Kill runaway queries |

---

## Per-Scenario Diagnosis Flow

### Bad Mapping (M)
```
1. index_mapping → see field types
2. field_caps → check searchable/aggregatable flags
3. index_stats → fielddata evictions confirm text-for-agg problem
4. (optional) _analyze → confirm tokenization behavior
5. FIX: reindex with correct mappings → alias swap
```

### Over-Sharded (S)
```
1. index_info → shard count vs doc count vs store size
2. shard_info → docs per shard, tiny shards
3. index_settings → confirm number_of_shards
4. node_stats → segment memory overhead per node
5. FIX: shrink or reindex to fewer shards
```

### Slow Queries (Q)
```
1. index_settings → slow log thresholds
2. index_stats → search query_time climbing
3. node_stats → thread pool rejections, heap pressure
4. running_tasks → long-running queries with bodies
5. query_profile → which clause is expensive
6. FIX: update_index_settings (raise thresholds), cancel_task, advise query rewrites
```

### Bad Replicas (R)
```
1. cluster_health → yellow/red status, unassigned count
2. shard_info → UNASSIGNED replicas
3. allocation_explain → which decider blocked placement
4. index_settings → replica count per index
5. node count from cluster_health → 1 node means replicas=0 is correct
6. FIX: update_index_settings (set replicas to 0 on single-node, 1 on multi-node)
```
