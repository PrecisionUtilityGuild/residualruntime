# Operational Walkthrough

**Audience:** Readers who want a rigorous operational understanding before building on the runtime  
**Position in the doc stack:** `README.md` -> `WALKTHROUGH.md` -> `ARCHITECTURE.md`  
**Companion example:** `npm run example:failure-case` or [`src/examples/concreteFailureCase.ts`](../src/examples/concreteFailureCase.ts)

This document is not a simplification layer. It is an **operator-semantics layer**: the same runtime, presented in the vocabulary of invariants, execution phases, and concrete traces. The repository intentionally keeps only a small active doc surface; this file is the rigorous middle layer between orientation and implementation contract.

## 1. The Same System in Three Registers

The project is one object described three ways:

- **Formal register:** state `S`, residual `R`, channels `ρ_a`, `ρ_d`, `ρ_t`, `ρ_e`, and the `Step` operator.
- **Architectural register:** discharge processor, constraint engine, transition engine, action gate.
- **Code register:** [`step`](../src/runtime/engine.ts), [`discharge`](../src/runtime/engine.ts), [`lift`](../src/runtime/engine.ts), [`DefaultTransitionEngine`](../src/runtime/transition.ts), and [`filterBlocked`](../src/runtime/predicates.ts).

The point of this walkthrough is to keep those three registers aligned rather than introducing a fourth vocabulary.

## 2. The Core Separation: `state` Is Not `residual`

This distinction is the first thing to keep hold of.

`state` is the committed semantic history of the system. In the current reference runtime it contains:

- commitments already treated as live facts
- belief mass used by evidence-sensitive rules
- rejected atoms that lost adjudication and are permanently foreclosed

`residual` is not committed history. It is the typed remainder of unfinished semantic work:

- assumptions that are still provisional
- deferred commitments whose dependencies are not yet resolved
- unresolved tensions that must be adjudicated
- evidence gaps that keep some action precondition below threshold

The runtime is built around not collapsing these two things into one store.

Operational consequence:

- `state` answers: what has already been settled?
- `residual` answers: what is still preventing legitimacy?

## 3. Why Blocking Depends on Both `residual` and `state`

The blocking gate is intentionally state-aware:

- open tensions and evidence gaps live in `residual`
- permanent loser-blocking lives in `state.rejected`

That is why the current runtime contract is `blocks(residual, state, action)` rather than a residual-only predicate.

This is not an implementation accident. It is the operational form of a deeper distinction between:

- **pending blockage**: an action is blocked because adjudication has not happened yet
- **persistent foreclosure**: an action is blocked because adjudication already happened against it

Without the `state.rejected` side, the runtime could block while a dispute is open but could not remember that one branch has been permanently ruled out after discharge.

## 4. The Five-Phase Runtime Contract

The reference runtime currently follows this shape:

```text
1. discharge(residual, state, input)
2. lift(residual_pre)
3. transition(state_pre, constraints, residual_pre)
4. filter_blocked(actions_candidate, residual_new, state_next)
5. emit(actions_approved)
```

Each phase owns a different kind of semantic responsibility.

### 4.1 Discharge

Discharge is the only phase allowed to evolve carried residual based on new input or policy.

Examples:

- evidence can shrink or resolve an `EvidenceGap`
- adjudication can remove a `Tension` and update committed/rejected atoms
- deferred items can remain and accumulate `stepsStuck`
- long-lived gaps can escalate

If a reader asks "where does unfinished work age, clear, or escalate?", the answer is: discharge.

### 4.2 Lift

Lift does not replay all residual. It projects only the parts that should re-enter the next step as active pressure.

In the current runtime:

- tensions lift as `Unresolved(...)`
- evidence gaps lift as `RequireEvidence(...)`
- deferred items are *not* naively lifted as propositions; they are carried with their own persistence semantics

That last point matters. A previous bug allowed stuck deferred items to leak into committed state too early. The current design is stricter: discharge owns satisfaction checks, while transition owns persistence of still-live deferred items.

### 4.3 Transition

Transition is where interpretation happens:

- constraints are applied to state
- candidate actions are generated
- new residual may be produced

This phase is deliberately pluggable. The runtime does not insist on one interpreter; it insists on one enforcement boundary.

### 4.4 Filter

Filtering is the legitimacy check.

This phase asks: given the newly computed state and residual, which candidate actions are admissible *now*?

That question is intentionally later than transition. The system first computes what might be attempted, then separates admissible from blocked actions.

### 4.5 Emit

Emission is conceptually outside the runtime kernel proper. The runtime determines what is legitimate to emit; another layer may decide how emitted actions are executed or logged.

## 5. The Four Residual Channels, Operationally

### 5.1 `ρ_a`: assumptions

Assumptions carry provisional semantic commitment with weight. They are not mainly about present-step blocking; they are about explicit provisionality and eventual retraction or confirmation.

### 5.2 `ρ_d`: deferred commitments

Deferred items say: "this commitment is real, but not yet live because named dependencies remain unresolved."

They matter operationally because they keep the system from pretending a dependency-guarded obligation is already ordinary state.

### 5.3 `ρ_t`: unresolved tensions

Tensions are the most distinctive channel in the project.

They are not just conflicting facts in a store. They are explicit pending disputes with adjudication-sensitive discharge. While live, they block actions depending on either side. After discharge, the winner may become committed while the loser becomes permanently rejected.

This is the channel that makes the runtime most unlike a plain monotone fact store, because it requires explicit pending-status machinery and adjudication-sensitive discharge.

### 5.4 `ρ_e`: evidence gaps

Evidence gaps make insufficiency explicit. They say: "this proposition is not merely false; it is under-evidenced relative to a threshold."

Operationally, they block dependent actions while also enabling escalation policy for long-lived insufficiency.

## 6. Safety Policies Are Not Extras

The current runtime includes:

- escalation events
- timeout-based tension adjudication
- deadlock detection for stuck residual items
- overflow events when residual size limits are breached

These are not bolt-on observability niceties. They are runtime responses to the failure modes named in the architecture:

- residual explosion
- permanent blocking
- long-lived non-resolution
- hidden semantic backlog growth

The project is strongest when these are understood as continuations of the kernel, not as miscellaneous engineering features.

## 7. Worked Trace: The Concrete Failure Case

The canonical trace lives in:

- [`src/__tests__/core.test.ts`](../src/__tests__/core.test.ts)
- [`src/examples/concreteFailureCase.ts`](../src/examples/concreteFailureCase.ts)

The trace has three moments.

### Step 1: Open tension

Input introduces `Unresolved(x=true, x=false)`.

An action depending on `x=true` is proposed.

Result:

- `naiveStep()` approves it, because it does not apply the blocking gate
- `step()` blocks it, because the tension is live

This is the minimum demonstration that the runtime is not just bookkeeping. It changes admissibility.

### Step 2: Adjudication

Input adjudicates the tension in favor of `x=true`.

Result:

- the tension is discharged
- `x=true` is committed
- `x=false` is rejected
- the previously blocked action can now be approved

This is the transition from pending blockage to ordinary legitimacy.

### Step 3: Loser branch returns

A new action depending on `x=false` is proposed after adjudication.

Result:

- it is blocked again, but for a different reason
- the reason is no longer an open tension
- the reason is persistent loser rejection recorded in state

This is exactly why the runtime separates `residual` from `state`. The open dispute disappears, but its adjudicative consequence remains.

## 8. What the Runnable Example Is Showing

The example is not just a demo script. It intentionally aligns four views of the same trace:

- action outcome (`approved` vs `blocked`)
- state change (`commitments`, `rejected`)
- residual change (`tensions`, etc.)
- replay summary / step diff

When you run it, read it as an execution trace of the kernel contract:

- before discharge
- after discharge
- after transition
- after filtering

That is the operational bridge between the code and the system contract.

## 9. What to Read Next

If this document makes sense, the next hop depends on what you want.

- For implementation boundaries and system ownership, continue to [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md).
- For concrete mechanics, continue into [`src/runtime/engine.ts`](../src/runtime/engine.ts) and [`src/runtime/transition.ts`](../src/runtime/transition.ts).
- For the canonical executable trace, run `npm run example:failure-case` or read [`src/examples/concreteFailureCase.ts`](../src/examples/concreteFailureCase.ts).

## 10. On Redundancy

The repository intentionally keeps a small active documentation surface:

- `README.md`: orientation
- `WALKTHROUGH.md`: operational understanding
- `ARCHITECTURE.md`: implementation contract

If another document is added in the future, it should earn its place by serving a distinct day-to-day role rather than preserving parallel framing.
