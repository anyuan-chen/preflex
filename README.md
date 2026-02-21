# Preflex

Preflex is an autonomous Elasticsearch ops agent. It monitors clusters, diagnoses misconfigurations, and fixes them: reindexing with correct mappings, shrinking over-sharded indices, tuning replicas, killing runaway queries. Actions stream to a live dashboard and Slack.

The core is a TypeScript MCP server with 11 read tools (cluster health, mappings, shard info, allocation explain, query profiling) and 6 write tools (reindex, shrink, update settings, manage aliases, cancel task). A streaming monitor polls ES every 10s, builds statistical baselines, and fires when metrics exceed 2σ. Anomalies dispatch to the Kibana Agent Builder, which chains diagnostic and repair tools autonomously. An optional HITL mode previews destructive operations before applying.

```
┌───────────────────────────────────────────────────────────────┐
│                  Dashboard  (Next.js + SSE)                    │
└─────────────────────────────┬─────────────────────────────────┘
                              │ window, anomaly, tool_call
┌─────────────────────────────▼─────────────────────────────────┐
│                        MCP Server                              │
│                                                                │
│  ┌────────────┐  ┌─────────────┐  ┌────────────────┐          │
│  │  Monitor   │  │ Read Tools  │  │  Write Tools   │          │
│  │            │  │             │  │                │          │
│  │ poll →     │  │ health      │  │ reindex        │          │
│  │ baseline → │  │ mappings    │  │ shrink         │          │
│  │ detect →   │  │ shards      │  │ settings       │          │
│  │ invoke     │  │ profile     │  │ aliases        │          │
│  └─────┬──────┘  └─────────────┘  └────────────────┘          │
│        ├── Slack ──▶ #alerts                                   │
│        └── invoke ▶ Kibana Agent ── tool calls ──┐             │
└──────────────────────────────────────────────────┼─────────────┘
                                                   ▼
                                          Elasticsearch
                                                   ▲
┌──────────────────────────────────────────────────┼─────────────┐
│                    GitHub Bot                     │             │
│                                                   │             │
│  PR opened → review diff → flag bad queries → validate against │
│  live cluster via MCP → submit fix PR autonomously             │
└────────────────────────────────────────────────────────────────┘
```

Testing is built around a sandbox system. Each sandbox spins up an isolated Docker cluster with a deliberately broken config, loads 1000 documents, and runs a phased query workload (warmup, analyst, dashboard at escalating QPS). Four scenarios cover common failures: wrong field types, 10 shards for 500 docs, replicas=3 on a single node, and leading wildcards with deep pagination. Each has a golden file of expected problems; an eval harness scores diagnosis A through F. The full create-to-eval loop runs in under three minutes.

A GitHub bot built on the Claude Agent SDK watches PRs for problematic Elasticsearch patterns: leading wildcards, unbounded aggregations, missing keyword fields, deep pagination. When it finds issues, it connects to the MCP server to validate fixes against a live cluster, then submits a fix PR on a `preflex/fix-{number}` branch. The bot runs as a webhook handler and posts inline review comments explaining what it found and why the rewrite is correct.

The sandbox scenarios use [Clee's Keys](https://github.com/anyuan-chen/clees-keys), a sample key-cutting store app, as the domain for realistic test data. Structure: `mcp-server/` (server + monitor), `lib/` + `sandbox` (cluster lifecycle + eval), `scenarios/` + `evals/` (test configs + golden files), `monitor/` (dashboard), `bot/` (GitHub integration). Uses Ollama locally by default for zero inference cost during development.

## License

[MIT](LICENSE)
