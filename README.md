# pi-agent-workbench

A pi package for agent-workbench experiments: durable observability, subagents, opt-in LLM delegation, and later workflow/workbench analysis.

## Agent Instructions

Start with [`AGENTS.md`](./AGENTS.md).

## Clean-Slate MVP

The active MVP plan is a cohesive workbench vertical slice:

- one `src/extensions/workbench.ts` entrypoint
- parent observability
- manual subagent commands
- opt-in LLM delegation
- process-based child pi runner
- shared event trace/run store
- minimal live status projection

Older phase specs are archived under `docs/implementation/archive/`.

## Planning Docs

- Full design reference: [`docs/agent-workbench-design.md`](./docs/agent-workbench-design.md)
- Implementation plan: [`docs/plan-readme.md`](./docs/plan-readme.md)
- Active MVP plan: [`docs/implementation/01-clean-slate-mvp-reimplementation.md`](./docs/implementation/01-clean-slate-mvp-reimplementation.md)
- Phase index: [`docs/implementation/README.md`](./docs/implementation/README.md)
- Principles: [`docs/implementation/00-principles.md`](./docs/implementation/00-principles.md)
- Contracts: [`docs/implementation/00-contracts-and-boundaries.md`](./docs/implementation/00-contracts-and-boundaries.md)
- Stretch goals: [`docs/implementation/99-stretch-goals.md`](./docs/implementation/99-stretch-goals.md)

## Scripts

```bash
npm test
```

## Later Manual pi Loading

Once the extension entrypoint exists:

```bash
pi --no-extensions \
  -e ~/sw/code/pi-agent-workbench/src/extensions/workbench.ts
```
