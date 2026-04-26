# Residual Runtime — Architecture

## What this is

A typed execution kernel that sits between your interpretation layer (LLMs, planners, rules) and your execution layer (APIs, tools, workflows). It maintains a **residual** — structured, lifecycled unfinished work over submitted signals — and enforces that no action executes while its precondition atoms remain unresolved in those signals.

As of **April 24, 2026**, this architecture is positioned as a specialized execution gate that composes with orchestration, governance, approvals, policy enforcement, and runtime-security systems rather than replacing them.

The architecture is optimized for one product outcome:

**convert a blocked action into a typed repair agenda.**

That repair agenda must be precise enough for a caller to decide whether the next move is adjudication, evidence acquisition, dependency satisfaction, replanning, session coordination, or waiting for another system.

```
[ Interpretation Layer ]   LLMs / planners / rule engines
         ↓  proposals + submitted signals
[ Residual Runtime ]       residual memory + action gate + repair certificates
         ↓  approved actions / typed blockers
[ Execution Layer ]        APIs / tools / workflows
```

---

## 1. Core Loop

```
step(state, residual, input, proposals):
  (residualPre, statePre) = discharge(residual, state, input)
  constraints             = merge(input.constraints, lift(residualPre))
  (stateNext, candidates, residualNext) = transition(statePre, constraints, proposals, residualPre)
  (actionsApproved, actionsBlocked) = filterBlocked(candidates, residualNext, stateNext)
  blockerAnalysis                   = analyzeBlocked(actionsBlocked, residualNext, stateNext)
  return (stateNext, residualNext, actionsApproved, actionsBlocked, blockerAnalysis, events)
```

**Invariant:** `TensionTimeoutPolicy` and manual adjudications both operate on `residualPre` — the residual after discharge of the prior step. A tension first introduced at step N is absent from `residualPre` at step N and cannot be adjudicated until step N+1.

`step()` itself returns the canonical state/residual/action/event result. The MCP surface turns blocked actions into `BlockerCertificate[]` so agents receive a compact repair contract instead of a residual dump.

---

## 1.5 Integration Contract

The kernel reasons only over the signals it receives. In production deployments, these integrations are expected:

1. CI/test systems publish conflict and pass/fail evidence updates.
2. Security/quality scanners publish threshold-bearing evidence updates.
3. Human approval systems publish deferred dependency satisfactions.
4. Incident/release/change-management systems publish adjudications and explicit reopen signals.
5. Action-proposing agents/services submit candidate actions with explicit `dependsOn` atoms.
6. Multi-agent/session coordinators submit optional `readSet` and `writeSet` claims with fresh branch/worktree context.

Without these feeds, the gate remains correct with respect to its submitted/observed inputs, but may be incomplete with respect to conditions no connected system has reported yet.

---

## 2. Data Model

### State

```typescript
{
  commitments:  Constraint[];                  // settled propositions (Γ)
  tensions:     Constraint[];                  // transition-internal working set; canonical live blockers remain in residual.tensions
  belief:       Record<string, number>;        // belief strength per atom (β)
  beliefSupport: Record<string, string[]>;     // AGM contraction support graph
  rejected:     string[];                      // permanently foreclosed atoms
  gapCounters:  Record<string, number>;        // stepsWithoutEvidence persisted across steps
}
```

### Residual

```typescript
{
  assumptions:  Assumption[];   // { kind, phi, weight, decayPerStep?, createdAt? }
  deferred:     Deferred[];     // { kind, constraint, dependencies, stepsStuck?, createdAt? }
  tensions:     Tension[];      // { kind, phi1, phi2, stepsAlive?, createdAt? }
  evidenceGaps: EvidenceGap[];  // { kind, phi, threshold, escalationSteps?, stepsWithoutEvidence?, createdAt? }
}
```

### Constraint (κ)

```typescript
| { type: "Prop";            phi: string }
| { type: "RequireEvidence"; phi: string; threshold: number }
| { type: "Unresolved";      phi1: string; phi2: string }
| { type: "Prefer";          phi: string; weight: number }
| { type: "Suspendable";     phi: string; condition: string }
```

### Action

```typescript
{
  kind:       "action";
  type:       string;
  dependsOn?: string[];   // atoms that must not be blocked for approval
  revocable?: boolean;    // if true, tracked in emittedRevocable; retracted via revokedActions
  readSet?:   string[];   // optional session coordination resources read by this action
  writeSet?:  string[];   // optional session coordination resources written by this action
}
```

### BlockerCertificate

MCP-facing blocked-action output. It separates strict unblock semantics from advisory acquisition work.

```typescript
{
  blockerId: string;
  blockerType:
    | "epistemic_rejected"
    | "epistemic_tension"
    | "epistemic_evidence_gap"
    | "epistemic_deferred"
    | "session_coordination";
  atoms: string[];
  permanent: boolean;
  sufficient: boolean;
  next:
    | { kind: "replan_without_rejected_atom"; rejectedAtoms: string[] }
    | { kind: "adjudicate_tension"; phi1: string; phi2: string; options: Array<{ winner: string; sufficient: boolean }> }
    | { kind: "provide_evidence"; phi: string; minBelief: number }
    | { kind: "satisfy_dependency"; phi: string }
    | { kind: "coordinate_session"; conflictType: "write_write" | "read_write"; resource: string; otherSessionId: string; unblock: Array<{ kind: string; detail: string }> };
  recommendations: {
    semantics: "advisory";
    moves: AcquisitionMove[];
  };
}
```

`next`, `permanent`, and `sufficient` are strict runtime semantics. `recommendations.moves` are operational suggestions such as `observe`, `query`, `run_check`, or `request_approval`; they never claim logical sufficiency by themselves.

---

## 3. Subsystems

### 3.1 Discharge Processor (`src/runtime/discharge/`)

Evolves residual each step:

- **Assumptions** — decay `weight` by `decayPerStep`; retract when weight reaches zero
- **Tensions** — apply manual adjudications (`input.adjudications`) and `TensionTimeoutPolicy`; winning atom committed to `state.commitments`; loser enters `state.rejected`; AGM contraction cascades
- **Evidence gaps** — apply `input.evidence`; clear gap when belief reaches threshold; increment `stepsWithoutEvidence` via `state.gapCounters`; escalate to `Deferred` after `escalationSteps`
- **Deferred** — resolve when all dependency atoms appear in `state.commitments` and none are under open tension

### 3.2 Constraint Engine (`src/runtime/constraints.ts`)

```
constraints = merge(input.constraints, lift(residualPre))
```

- Deduplicates identical constraints
- Takes max threshold for duplicate `RequireEvidence`
- Detects conflicts (atom simultaneously `Prop` and `Unresolved`)

### 3.3 Transition Engine (`src/runtime/transition.ts`)

Computes `(stateNext, candidates, residualNext)` from `(statePre, constraints, proposals, residualPre)`. Pluggable — swap the interpretation logic while the execution gate stays fixed.

### 3.4 Action Gate (`src/runtime/predicates.ts`)

```
actionsApproved = filterBlocked(candidates, residualNext, stateNext)
```

Blocks any action whose `dependsOn` atoms intersect:
- atoms under open tension (`residual.tensions`)
- atoms below evidence threshold (`residual.evidenceGaps`)
- atoms behind unresolved deferred dependencies (`residual.deferred`)
- atoms in `state.rejected` (permanent — no residual change can reinstate)

`whatWouldUnblock(action, residual, state)` inverts this: returns the minimal typed set of residual changes that would lift each blocker.

`blockerCertificates(action, residual, state)` compresses blocker analysis into one certificate per blocker family:

- rejected atoms become permanent `replan_without_rejected_atom` certificates
- tensions become `adjudicate_tension` certificates with winner options and per-option `sufficient`
- evidence gaps become `provide_evidence` certificates with `minBelief`
- deferred dependencies become `satisfy_dependency` certificates

The MCP server appends `session_coordination` certificates for cross-session resource conflicts.

### 3.5 Repair Surface (`src/runtime/predicates.ts`, `src/mcp/server.ts`)

The repair surface is the project’s main solution layer.

It has three tiers:

1. **Predicate:** `blocks(residual, state, action)` answers whether the action is admissible.
2. **Counterfactual:** `whatWouldUnblock(...)` answers which residual deltas would change admissibility.
3. **Operational certificate:** `blocked[].certificates[]` answers what the caller should do next, while preserving the difference between strict semantics and advisory acquisition moves.

At the MCP layer, this stays intentionally minimal: `step` returns lean blocked certificates, and `suggest_repairs` compiles those certificates into a deterministic repair plan on demand without introducing session side effects.

This is intentionally not a natural-language explanation layer. It is a machine-readable repair contract.

---

### 3.6 Repair Runbook Contract (`src/runtime/repair.ts`, `src/runtime/types/repair.ts`)

`runRepairCycle` is the bounded execution protocol that converts blocked-action certificates into deterministic repair attempts without introducing autonomous authority selection.

Core types:

- `RepairIntent`: compiled strict directive + advisory moves for one blocker
- `RepairAdapter`: capability-scoped adapter (`query`, `run_check`, `request_approval`, `observe`, `adjudicate`, `coordinate`)
- `RepairObservation`: adapter-produced patch payload (`inputPatch`, optional `proposalPatch`, optional `contextPatch`) with provenance
- `RepairCycleTrace`: per-cycle certificate set, compiled plan, observations, generated patches, and resulting `step()` outcome

Execution semantics (`runRepairCycle`):

1. Compute blocker certificates for target action.
2. Compile deterministic repair plan (`compileRepairPlan`, stable `blockerId` ordering).
3. If any permanent blocker exists, fail immediately with `permanent_blocker` (replan required).
4. Invoke adapter strict directives first, then advisory moves.
5. Merge observation patches into one generated `input/proposals/context` payload.
6. Call `step()` with target action plus generated proposals.
7. Stop when target action is approved, or fail on `missing_capability` / `max_cycles_exceeded`.

Trace semantics:

- Every observation includes provenance (`adapterId`, capability, strict/advisory source, blocker/intent IDs, target, observed timestamp).
- Every cycle records inputs and outcomes so replay can answer "why still blocked?" or "what changed to unblock?".
- Determinism depends on stable certificate ordering + deterministic adapter behavior + deterministic `step()` policy configuration.

Boundary semantics:

- The repair loop does not discover world truth.
- It does not decide which external system is authoritative.
- It does not replace orchestration, policy, governance, or HITL approval planes.
- It only compiles runtime blocker semantics into bounded acquisition attempts and re-evaluates admissibility through `step()`.

---

## 4. Residual Lifecycle

```
Proposed → In residual → Discharged
                ↓
          (if stuck)
                ↓
         Escalation / Deadlock / Timeout events
```

- **Evidence gap** escalates to `Deferred` after `escalationSteps` (preserving original threshold)
- **Tension** auto-adjudicates after `TensionTimeoutPolicy.maxSteps` or `wallClockMs`
- **Deferred** reports deadlock after `stepsStuck` exceeds threshold
- **Oscillation** detected when `computeFingerprint(residual)` cycles (covers all four item types)

---

## 5. Safety Policies (`src/runtime/policies.ts`)

| Policy | Trigger | Output |
|---|---|---|
| Overflow | residual size exceeds limit | `ResidualOverflowEvent` |
| Escalation | gap stuck > `escalationSteps` | `EscalationEvent`; gap promoted to `Deferred` |
| Deadlock | tension/deferred/gap stuck > threshold | `DeadlockEvent` |
| Oscillation | fingerprint cycles | `OscillationEvent` |
| Timeout adjudication | tension alive > `maxSteps` or `wallClockMs` | auto-adjudication via policy resolve fn |
| Invalid adjudication | winner ∉ {phi1, phi2} | `InvalidAdjudicationEvent`; tension stays open |

---

## 6. Formal Verification

### AGM Belief Contraction

`contractBelief(state, phi)` retracts the loser atom and cascade-retracts any beliefs whose only support was the loser. Minimal-change semantics: beliefs with other supporters survive.

### CCP₀ Trace Verification

`translateTrace(replay)` converts a step sequence to a CCP₀ tell/ask trace.  
`verifyCcpTrace(trace)` checks:
- **Monotonicity** — no atom is told twice (committed state never regresses)
- **Ask-consistency** — every approved action was in the store at its step; every blocked action was not

`replayLog({ ccpVerify: true })` runs this on every replay.

---

## 7. Replay and Persistence

`appendStep(log, replay)` writes each step to an NDJSON file.  
`replayLog(log, options)` reconstructs the trace and optionally verifies:

- `stateVerify: true` — checks `belief`, `rejected`, `commitments`, `gapCounters`, `beliefSupport` against stored snapshots
- `ccpVerify: true` — runs CCP₀ verification on the full trace

File adapter (`createFileLog`) survives process restarts for log/replay use cases. Action identity is checked on replay using `type + sorted(dependsOn)` — preventing false matches on same-type different-dependsOn actions.

### MCP session contract

The MCP `SessionManager` persists session state in `sessions.sqlite` (WAL mode) and treats each session as an objective lifecycle (for example a ticket, PR, or incident), not a branch identity.

- Session metadata is persisted with:
  - `objectiveType?`, `objectiveRef?`, `title?`
  - `status` (`active` | `closed`)
  - `createdAt`, `closedAt?`
- Session root directory resolves in this order: explicit `sessionRootDir` arg, `RESIDUAL_SESSION_ROOT_DIR`, `./.residual-sessions`, `$HOME/.codex/residual-runtime/sessions`, OS temp fallback.
- Append-only `session_events` rows are indexed by `(session_id, step_index)` and `recorded_at`.
- Each `step` may include optional provenance `context`:
  - `branch?`, `commitSha?`, `worktreeId?`, `actorId?`
- `step` context is written onto replay events for auditability without changing the core gating semantics.
- `new_session` can seed initial state using `seedInput`, `seedProposals`, and optional `stepOptions`.
- `list_sessions` returns both session summaries and the resolved `sessionRootDir`.
- MCP tool payloads are strict-validated (no unknown keys; blank IDs and malformed proposal/input payloads are rejected).
- `suggest_repairs` accepts a single blocked action payload (`action` + non-empty `certificates[]`) and returns a deterministic repair plan compiled from strict blocker semantics; it does not mutate session state.
- Actions may declare optional `readSet?: string[]` and `writeSet?: string[]` resource keys.
- On each MCP `step`, actions that pass residual gating are additionally checked against the latest approved actions in other active sessions sharing `worktreeId` (preferred) or `branch` scope.
- Overlaps block deterministically:
  - `writeSet ∩ writeSet` => `write_write`
  - `writeSet ∩ readSet` or `readSet ∩ writeSet` => `read_write`
- Cross-session blocks are surfaced as `SessionConflictEvent[]` in `StepResult.sessionConflicts` and in MCP `events.sessionConflicts`, including typed unblock guidance.
- Arbitration policy module resolves each conflict into a deterministic `SessionArbitrationEvent` with:
  - mode: `serialize_first` or `branch_split_required`
  - precedence: conflict class rank + objective priority + deterministic tie-break (`created_at`, then `session_id`)
  - outcome-specific unblock guidance (`wait_for_other_session`, `split_scope`, `integration_action`, `narrow_resource_sets`)
- Effective policy metadata is returned on every step via `StepResult.sessionArbitrationPolicy` / MCP `events.sessionArbitrationPolicy`.
- Operational cutover controls:
  - env defaults: `RESIDUAL_ARBITRATION_ENABLED`, `RESIDUAL_ARBITRATION_MODE`, `RESIDUAL_ARBITRATION_WRITE_WRITE_MODE`, `RESIDUAL_ARBITRATION_READ_WRITE_MODE`
  - per-step override: `step(..., arbitrationPolicy)`
- Replay traces persist `replay.sessionEvents.{conflicts,arbitrations}` for audit and observability summaries.
- Concurrent stale writers on the same session step index fail with a deterministic retry signal (`Concurrent session update detected ...`).
- Legacy `*.ndjson` sessions can be imported via `npm run mcp:migrate -- --root <session-dir>`.

---

## 8. Immutability

`stateNext` and `residualNext` returned by `step()` are never mutated after return. Internal mutations operate on deep-cloned intermediates. Objects are shallow-frozen at the return boundary in `NODE_ENV=test|development`. Verified by tests M46-A, M46-B, M46-C.

---

## 9. Codebase Map

```
src/
  index.ts                   — public API barrel
  runtime/
    engine.ts                — step(), naiveStep(), discharge(), lift()
    transition.ts            — DefaultTransitionEngine
    predicates.ts            — blocks(), blockingAtoms(), filterBlocked(), whatWouldUnblock(), blockerCertificates()
    policies.ts              — computeFingerprint(), detectOscillations(), computeSoftBlocked(), computeDeadlocks()
    constraints.ts           — mergeConstraints(), detectConflicts()
    model.ts                 — type barrel
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
  cli/
    index.ts                 — interactive Ollama demo loop
    scenario.ts              — deployment scenario seed and system prompt
  mcp/
    server.ts                — MCP stdio server + tool contracts
    sessions.ts              — objective-scoped session manager + SQLite store
    arbitration.ts           — deterministic cross-session arbitration policies
    migrate.ts               — legacy NDJSON -> SQLite migration CLI
  research/
    reencoding.ts            — experimental CCP₀ trace normalization (not exported)
  __tests__/                 — Node built-in test suite, including MCP server/session coverage
```

---

## 10. Consistency Matrix

Every term that appears in code or docs must be registered here before use. Name in code must match exactly.

| Term | Symbol | Owner |
|---|---|---|
| `state` | `S = <Γ, Φ, β>` | State / engine.ts |
| `residual` | `R = <ρ_a, ρ_d, ρ_t, ρ_e>` | Residual Engine |
| `assumptions` | `ρ_a` | discharge/assumptions.ts |
| `deferred commitments` | `ρ_d` | discharge/deferred.ts |
| `unresolved tensions` | `ρ_t` | discharge/tensions.ts + predicates.ts |
| `evidence gaps` | `ρ_e` | discharge/evidenceGaps.ts |
| `incoming constraints` | `C` | constraints.ts |
| `lifted residual constraints` | `lift(R)` | engine.ts |
| `transition function` | `I(S, C)` | transition.ts |
| `candidate actions` | `A_candidate` | transition.ts |
| `approved actions` | `A_approved = filterBlocked(A_candidate, R, S)` | predicates.ts |
| `blocking predicate` | `blocks(R, S, action)` | predicates.ts |
| `discharge step` | `discharge_step(R, S, input)` | discharge/index.ts |
| `step orchestration` | `Step(S, R, input)` | engine.ts |
| `suspendable constraint` | `Suspendable(phi, condition)` | constraints.ts (soft-blocks via computeSoftBlocked; does not hard-block) |
| `revocable action` | `Action.revocable = true` | predicates.ts (emittedRevocable; revokedActions on retraction) |
| `invalid adjudication` | `InvalidAdjudicationEvent` | engine.ts (emitted when winner ∉ {phi1,phi2}; tension remains open) |
| `AGM contraction` | `contractBelief(state, phi)` | discharge/tensions.ts |
| `gap counter` | `State.gapCounters` | domain.ts / discharge/evidenceGaps.ts |
| `oscillation fingerprint` | `computeFingerprint(residual)` | policies.ts (all four item types) |
| `replay action identity` | `actionKey(action)` | store.ts (type + sorted dependsOn) |
| `state verification` | `replayLog(..., { stateVerify: true })` | store.ts |
| `CCP₀ trace` | `CcpTrace` | verify/ccp0.ts |
| `residual delta` | `ResidualDelta` | predicates.ts (adjudicate-tension, satisfy-evidence-gap, commit-deferred-dependency; each with `sufficient: boolean`) |
| `counterfactual discharge` | `whatWouldUnblock(action, residual, state) → UnblockAnalysis` | predicates.ts |
| `unblock analysis` | `UnblockAnalysis` | predicates.ts (`{ permanent: boolean; deltas: ResidualDelta[] }`) |
| `blocker certificate` | `BlockerCertificate` | predicates.ts + mcp/server.ts (strict `next` semantics plus advisory recommendations) |
| `acquisition move` | `AcquisitionMove` | predicates.ts (observe, query, request_approval, run_check) |
| `repair surface` | `blocks + whatWouldUnblock + BlockerCertificate` | predicates.ts + mcp/server.ts |
| `strict unblock semantics` | `next + permanent + sufficient` | BlockerCertificate |
| `advisory acquisition` | `recommendations.moves` | BlockerCertificate (`semantics: "advisory"`) |
| `residual item timestamp` | `createdAt?: number` | domain.ts (unix ms; set on first introduction; never mutated) |
| `residual item age` | `ageOf(item, nowMs) → number \| undefined` | domain.ts |
| `wall-clock timeout` | `TensionTimeoutPolicy.wallClockMs?: number` | engine.ts |
| `state immutability` | `freezeIfTest(obj)` | engine.ts (shallow-frozen in test/development) |
| `evidence gap deadlock` | `DeadlockEvent { itemKind: "evidence_gap" }` | policies.ts |
| `session metadata` | `SessionMetadata` | mcp/sessions.ts + domain.ts |
| `step provenance context` | `EventContext` | mcp/server.ts + events.ts |
| `action read set` | `Action.readSet?: string[]` | domain.ts + mcp/sessions.ts |
| `action write set` | `Action.writeSet?: string[]` | domain.ts + mcp/sessions.ts |
| `cross-session conflict event` | `SessionConflictEvent` | events.ts + mcp/sessions.ts |
| `session arbitration policy` | `SessionArbitrationPolicy` | events.ts + mcp/arbitration.ts |
| `session arbitration event` | `SessionArbitrationEvent` | events.ts + mcp/arbitration.ts + mcp/sessions.ts |
| `arbitration mode` | `SessionArbitrationMode` | events.ts + mcp/arbitration.ts |
| `arbitration outcome` | `SessionArbitrationOutcome` | events.ts + mcp/arbitration.ts |
| `conflict scope` | `SessionConflictScope` | events.ts + mcp/sessions.ts |
| `conflict type` | `SessionConflictType` | events.ts + mcp/sessions.ts |

**Naming rule:** if a new term is introduced in code or docs, add it here with symbol and owner before merge.

---

## 11. Design Principles

1. **Residual is first-class.** Never collapse it into logs, metadata, or hidden state.
2. **Blocking is explicit.** No implicit soft failures.
3. **Blocked work becomes repair work.** Every temporary hard block should point at typed next work, not just say no.
4. **Strict semantics stay separate from advice.** `next`/`sufficient`/`permanent` are not blended with operational recommendations.
5. **Discharge is deterministic.** No silent resolution; every discharge event is typed and auditable.
6. **Separation of concerns.** Interpretation ≠ validation ≠ execution.
7. **Composability.** Integrates with existing workflow, approval, governance, policy, and runtime-security systems; does not replace them.
8. **State immutability.** `stateNext` and `residualNext` are never mutated after `step()` returns.
