# CLAUDE.md — Residual Runtime

This file is read at the start of every session. Follow these rules without exception.

---

## What this project is

A production kernel that enforces **semantic validity** of actions under incomplete information.
The core insight: an action is blocked not because a caller lacks permission, but because the
*world-state is not yet coherent enough* to commit to it. Residual (unfinished semantic work)
is a first-class, typed, lifecycled data structure — not a log, not metadata.

Read `docs/ARCHITECTURE.md` and `docs/WALKTHROUGH.md` before proposing any change.
The Consistency Matrix in `ARCHITECTURE.md §10` is the canonical name registry.

---

## Hard rules — enforced every session

### 1. No new file unless a new semantic concept requires it
Add to an existing module first. A new file is only justified when a concept has no existing
owner. If unsure, ask before creating.

### 2. No exported symbol without a test
Every function exported from `src/index.ts` must have at least one test in `src/__tests__/`.
No exceptions. Research code in `src/research/` is exempt — it must NOT be exported from index.

### 3. No new data structure without an ARCHITECTURE.md entry first
Before writing code for any new type, add it to `ARCHITECTURE.md §10` (Consistency Matrix)
with: name, symbol, and owning subsystem. Name in code must match the matrix exactly.

### 4. `src/research/` is the sandbox
Experimental code lives in `src/research/`. It is never exported from `src/index.ts` until
it has passed a full mission review and earned a place in the runtime.

### 5. Examples must be runnable end-to-end
Every file added to `src/examples/` must be wired to an `npm run example:X` script in
`package.json` and must run clean (`npm run build && node dist/examples/X.js`).

### 6. Dependency flow is one direction only
```
types → discharge → policies → engine → index
```
No reverse imports. `engine.ts` may not import from `index.ts`. `types/` may not import
from anywhere else in runtime. Violating this is a hard block on the PR.

### 7. One subsystem per mission
A mission touches exactly one subsystem unless `ARCHITECTURE.md` is updated first to
document the cross-subsystem contract. Mixing subsystems without a doc update is a sign
the mission scope is wrong.

### 8. State is immutable through the public API
`State` and `Residual` objects returned by `step()` are never mutated by callers. All
mutations go through `step()`. If a new helper needs to modify state, it must return a
new object — never mutate in place.

### 9. No comments that describe what the code does
Only comment when the WHY is non-obvious: a hidden constraint, a formal invariant, a
workaround for a specific semantic edge case. No docblocks. No "this function does X."

### 10. `npm run ci` must pass before any mission is closed
`ci` runs `typecheck` + full test suite. All tests green, zero type errors. No exceptions.

---

## Current priority missions (ranked)

1. **MCP parity + docs integrity sweep** — keep `README.md`, `docs/WALKTHROUGH.md`, and `docs/ARCHITECTURE.md` aligned with `src/mcp/*` behavior and contracts.

2. **MCP operational hardening** — preserve deterministic cross-session arbitration (`sessionEvents`, unblock guidance, policy metadata) without changing core residual semantics.

3. **Session lifecycle ergonomics** — improve objective metadata continuity and migration UX while keeping replay compatibility.

## Ideas that are NOT missions yet

- Causal DAG over residual — absorbed into `whatWouldUnblock` output
- Inter-agent residual negotiation protocol — revisit after 2+ real consumers exist
- Half-life / probabilistic decay — not a kernel concern, breaks replay tractability

---

## Codebase map (quick reference)

```
src/
  index.ts                   — public API barrel (60+ exports)
  runtime/
    engine.ts                — step(), naiveStep(), discharge(), lift()
    transition.ts            — DefaultTransitionEngine (pluggable)
    predicates.ts            — blocks(), blockingAtoms(), filterBlocked()
    policies.ts              — computeFingerprint(), detectOscillations(), computeSoftBlocked()
    constraints.ts           — mergeConstraints(), detectConflicts()
    model.ts                 — type barrel (domain + events)
    observe.ts               — diffStep(), computeMetrics(), summarizeTrace()
    store.ts                 — StepLogAdapter, replayLog()
    fileAdapter.ts           — createFileLog()
    types/
      domain.ts              — Residual, State, Constraint, Action, core types
      events.ts              — StepResult, EscalationEvent, all event types
    discharge/
      assumptions.ts         — dischargeAssumptions()
      deferred.ts            — dischargeDeferred()
      evidenceGaps.ts        — dischargeEvidenceGaps()
      tensions.ts            — dischargeTensions(), contractBelief()
      index.ts               — dischargeAll(), applyEvidence()
    verify/
      ccp0.ts                — translateTrace(), verifyCcpTrace()
  examples/
    concreteFailureCase.ts   — canonical single-tension blocking demo
    multiAgentResidual.ts    — ICU triage multi-agent demo
  mcp/
    server.ts                — MCP stdio server + tool contracts
    sessions.ts              — objective-scoped session manager + SQLite persistence
    arbitration.ts           — deterministic cross-session conflict arbitration
    migrate.ts               — legacy NDJSON migration utility
  research/
    reencoding.ts            — experimental CCP₀ trace normalization
  __tests__/                 — Node built-in test suites (runtime + MCP coverage)
```

---

## Commands

```bash
npm run build          # clean + compile
npm run test           # build + run all tests
npm run typecheck      # type-check only, no emit
npm run ci             # typecheck + test (run before closing any mission)
npm run example:failure-case
npm run mcp            # start MCP stdio server
npm run mcp:dev        # run MCP server from TypeScript source
npm run mcp:migrate    # import legacy NDJSON sessions into SQLite
```
