# AGENTS.md

Rules for coding agents integrating the `cc-stacktracer` SDK live in
**[`docs/guides/agents.md`](docs/guides/agents.md)**.

The content is there, and not inline here, for one reason: `docs/guides/` is the only path the
knowledge manifest indexes (`docPathSchema` requires `^docs/…\.md$`), and that index is what lets
the platform's own assistant answer from the same rules an agent reads. A copy in this file would
be a second source, and second sources drift.

Quick start, if you are an agent and want the one command that matters:

```bash
npx cc-stacktracer doctor --json
```
