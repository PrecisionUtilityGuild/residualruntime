# residual-runtime

A typed runtime kernel that blocks AI agent actions when the world isn't ready — and tells you exactly what needs to change before they can go through.

---

## The problem

An AI agent proposes `DEPLOY_TO_PRODUCTION`. Two CI systems disagree on whether tests passed. The security scan score is at 0.6, not the required 0.8. The lead review isn't done.

Every existing agent framework lets the action fire anyway — unless you wrote a guard rule in advance that catches this exact combination. Most don't. Even if you did, the rule can't tell you *what specifically* needs to resolve before the action becomes valid.

Residual Runtime blocks the action automatically — not from a rule, but from the live epistemic state of the world — and returns:

```ts
whatWouldUnblock(action, residual, state)
// →
[
  { kind: "adjudicate-tension",        phi1: "tests=passing", phi2: "tests=failing", winner: "tests=passing", sufficient: true  },
  { kind: "satisfy-evidence-gap",      phi: "security_scan",  requiredBelief: 0.8,                            sufficient: false },
  { kind: "commit-deferred-dependency", phi: "lead_review=done",                                              sufficient: false },
]
```

Each delta is the minimal change that would lift a specific blocker. `sufficient: true` means that single change is enough on its own.

---

## How it works

The kernel only knows what gets submitted to it. That means the systems that observe the world — CI pipelines, scanners, approval workflows — need to be wired up to call `step()` when something changes. The kernel handles what those submissions mean for which actions can fire. The integrations themselves are your responsibility.

Each participant submits what it knows via `step()`:

```ts
// CI system — a conflict arrived
step({ proposals: [{ kind: "tension", phi1: "tests=passing", phi2: "tests=failing" }] })

// Scanner — evidence for a specific atom
step({ input: { evidence: { security_scan: 0.94 } } })

// Human approval UI — a commitment resolved
step({ input: { constraints: [{ type: "Prop", phi: "lead_review=done" }] } })

// Agent — wants to act
step({ proposals: [{ kind: "action", type: "DEPLOY_TO_PRODUCTION", dependsOn: ["tests=passing", "security_scan", "staging_approved"] }] })
```

The engine accumulates **residual** — typed, lifecycled unfinished semantic work. An action is blocked whenever any atom in its `dependsOn` is under open tension, below evidence threshold, or behind an unresolved deferred dependency. When residual clears, the action is approved.

---

## Residual types

| Type | What it represents | Blocks when |
|---|---|---|
| `Tension` | two conflicting claims about the world | open — neither side has been adjudicated |
| `EvidenceGap` | a belief that must reach a threshold | belief is below threshold |
| `Deferred` | a commitment waiting on upstream dependencies | dependencies haven't resolved |
| `Assumption` | a weak default belief that decays over time | advisory only — does not hard-block |

---

## The action gate

`step()` runs four phases on every call:

1. **Discharge** — evolve residual from incoming evidence, adjudications, and time
2. **Lift** — derive blocking constraints from surviving residual
3. **Transition** — evolve state and assemble candidate actions
4. **Filter** — approve or block each candidate based on live residual state

`naiveStep()` runs the same pipeline without the filter — a baseline showing what current systems do: fire actions regardless of open disputes.

---

## What's built

- **Core runtime** — `step()`, `naiveStep()`, `discharge()`, `lift()`, `filterBlocked()`, `blocks()`, `blockingAtoms()`
- **Counterfactual unblocking** — `whatWouldUnblock(action, residual, state) → UnblockAnalysis`
- **AGM belief revision** — `contractBelief()` cascades minimal belief retraction on adjudication
- **Revocable actions** — approved revocable actions tracked; retracted if a later step would block them
- **Temporal residual** — `createdAt` on all residual items; `ageOf(item, nowMs)`; `TensionTimeoutPolicy` with `wallClockMs` for wall-clock timeouts
- **Safety policies** — deadlock detection, oscillation detection, overflow signaling, escalation (evidence gaps promoted to deferred), auto-adjudication, invalid adjudication reporting
- **Observability** — `diffStep()`, `computeMetrics()`, `summarizeTrace()`
- **Replay and persistence** — `appendStep()` / `replayLog()` with full state verification; NDJSON file adapter
- **CCP₀ formal verification** — `translateTrace()` + `verifyCcpTrace()`; wired into `replayLog({ ccpVerify: true })`
- **Pluggable transition engine** — swap the interpretation layer while the gate stays fixed
- **CLI demo** — `npm run cli` runs a local Ollama LLM through the gate end-to-end

---

## Quick start

```sh
git clone <repo>
npm install
npm run example:failure-case   # canonical traced demo
npm run cli                    # interactive LLM demo (requires Ollama + llama3.1:8b)
npm test                       # build + run all 121 tests
npm run ci                     # typecheck + test
```

---

## The canonical failure case

```ts
import { step, naiveStep, whatWouldUnblock, createEmptyResidual, createInitialState } from "./src/index";

const action  = { kind: "action", type: "USE_X_TRUE", dependsOn: ["x=true"] };
const tension = { type: "Unresolved", phi1: "x=true", phi2: "x=false" };

// Naive system: fires despite open dispute
const naive = naiveStep({ state: createInitialState(), residual: createEmptyResidual(), input: { constraints: [tension] }, proposals: [action] });
console.log(naive.actionsApproved); // [USE_X_TRUE] — wrong

// Runtime: blocked
const s1 = step({ state: createInitialState(), residual: createEmptyResidual(), input: { constraints: [tension] }, proposals: [action] });
console.log(s1.actionsBlocked); // [USE_X_TRUE]

// What would unblock it?
const analysis = whatWouldUnblock(action, s1.residualNext, s1.stateNext);
console.log(analysis.permanent); // false — fixable
console.log(analysis.deltas);
// [
//   { kind: "adjudicate-tension", phi1: "x=true", phi2: "x=false", winner: "x=true",  sufficient: true  },
//   { kind: "adjudicate-tension", phi1: "x=true", phi2: "x=false", winner: "x=false", sufficient: false },
// ]

// Adjudication resolves it
const s2 = step({ state: s1.stateNext, residual: s1.residualNext, input: { adjudications: [{ phi1: "x=true", phi2: "x=false", winner: "x=true" }] }, proposals: [action] });
console.log(s2.actionsApproved); // [USE_X_TRUE]

// Losing branch permanently foreclosed
const s3 = step({ state: s2.stateNext, residual: s2.residualNext, input: {}, proposals: [{ kind: "action", type: "USE_X_FALSE", dependsOn: ["x=false"] }] });
const blocked = whatWouldUnblock({ kind: "action", type: "USE_X_FALSE", dependsOn: ["x=false"] }, s3.residualNext, s3.stateNext);
console.log(blocked.permanent); // true — no residual change can fix a rejected atom
```

---

See [docs/WHY.md](docs/WHY.md) for how this differs from orchestration frameworks, rule-based enforcement, and identity governance tools.
See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full component model, data model, and execution model.
