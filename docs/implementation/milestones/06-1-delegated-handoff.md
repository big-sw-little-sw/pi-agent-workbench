# Milestone 06-1 — Delegated Handoff (Post-MVP / Follow-On)

## Goal

Allow the parent LLM to request a handoff through an explicitly enabled, policy-gated tool/API, using the handoff records, lineage, and successor-session semantics from Milestone 03-2.

This is not part of the 03-2 handoff MVP. It is a follow-on after the handoff core and delegation policy surfaces exist.

## Depends On

- Milestone 03-2 handoff context transition.
- Milestone 06 delegation MVP policy/session gating.
- Runtime support for creating successor sessions and lineage records from a tool/action context.

## Scope

Implement a model-callable handoff capability only when explicitly enabled.

Potential tool shape:

```ts
handoff({
  method: "extractive" | "manual" | "static",
  goal?: string,
  prompt?: string,
  artifacts?: string[],
  targetAgentName?: string,
  autoStart?: boolean,
  lineageExportPath?: string,
})
```

## Policy

- Delegated handoff is opt-in, session-scoped, and disabled by default.
- Enabling subagent delegation does not automatically enable handoff delegation unless explicitly configured/commanded.
- Use separate enablement controls, for example `/delegation handoff on` and `/delegation subagents on`.
- Like subagent delegation, delegated handoff may have an explicit startup config/CLI flag to enable it at session start. This must be explicit and should not be inferred from generic delegation being enabled.
- No fire-and-forget in the first delegated version.
- `autoStart` must be policy-gated separately from draft/artifact-only handoff.
- Current-conversation replacement remains out of scope unless explicitly designed later.
- Target named agents are allowed only from trusted loaded agent profiles.
- Static mode requires explicit artifacts.

## Observability

- Use `handoff_*` events, not `subagent_*` events.
- Set `controlMode: "delegated"` for delegated handoff events.
- Preserve source/target separate linked workbench runs.
- Extractor usage belongs to the source run.
- Target run usage belongs to the target run.
- Lineage export must work from either source or target side.
- Record policy decisions and denials as handoff/delegation events or errors as appropriate.

## UX / Safety

A delegated handoff can unexpectedly switch sessions or launch target execution, so first implementation should prefer safe modes:

- default delegated handoff creates a draft/artifact record only when possible
- delegated `autoStart` requires explicit policy opt-in
- interactive mode should require confirmation before switching sessions or auto-starting by default, configurable by explicit policy
- headless auto-start waits for target completion and returns non-zero if target run fails

## Out of Scope

- Multiple target sessions in one tool call.
- Fire-and-forget/background target execution.
- Handoff profile/custom extractor system.
- Using named agents as extractors.
- Current-session replacement.

## Open Questions

1. Exact command/config/CLI names for separate delegated handoff enablement, such as `/delegation handoff on` and a startup flag/config item.
2. Exact config/command names for interactive delegated handoff confirmation policy; default is confirmation before session switch/auto-start.
3. Should delegated handoff be one generic tool or a mode of a broader context-management tool?
4. What is the default delegated behavior when the parent LLM requests `autoStart` but policy disallows it: deny, downgrade to draft, or ask user?
