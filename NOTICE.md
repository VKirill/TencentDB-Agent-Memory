# NOTICE

`@vkirill/tencentdb-agent-memory` is a fork of
[Tencent/TencentDB-Agent-Memory](https://github.com/Tencent/TencentDB-Agent-Memory)
at version **0.3.4**, licensed under the MIT License.

## What was reused

The four-layer memory engine (`src/core/*`) — including the SQLite store,
vector + FTS hybrid recall, the L0 → L1 → L2 → L3 pipeline, prompts,
embedding abstractions, conversation/scene/persona modules — is reused
verbatim from upstream. This is the value-bearing asset of the fork.

## What was changed

- Decoupled from the OpenClaw plugin runtime + Hermes Docker sidecar
  (deleted `hermes-plugin/`, `docker/`, `src/adapters/openclaw/`,
  `src/offload/`, `src/gateway/`, all postinstall patches)
- Re-targeted at a standalone CLI (`init`, `capture`, `recall`, `stats`)
  for use with Claude Code and other agents
- Defaults to OpenRouter (`tencent/hy3-preview`) as the LLM provider
  and Voyage AI (`voyage-3-lite`, 512-d) as the embedding provider —
  both via OpenAI-compatible HTTP

See `CHANGELOG.md` for the per-version breakdown.

## Upstream license

```
MIT License

Copyright (c) 2026 Tencent

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.
```

Full license text in `LICENSE` (preserved from upstream).
