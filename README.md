# residual-runtime

A typed execution kernel for actions that depend on live, changing world-state. It blocks actions when submitted signals still contain unresolved blockers, and it tells you what would need to change to unblock them.

---

## The problem

An AI agent proposes `DEPLOY_TO_PRODUCTION`. Two CI systems disagree on whether tests passed. The security scan score is at 0.6, not the required 0.8. The lead review isn't done.

Existing systems already solve important adjacent problems:

- workflow runtimes can sequence, pause, and resume work
- policy engines can allow or deny actions based on declared rules
- governance layers can control tools, APIs, and resources at runtime
- approval systems can stop risky actions until a human decides

Residual Runtime targets a narrower problem: **an action can be structurally allowed and still not be valid yet because the submitted world-state signals remain unresolved.**

Instead of returning only "blocked", the kernel returns typed unblock guidance:

```ts
whatWouldUnblock(action, residual, state)
// →
[
  { kind: "adjudicate-tension",        phi1: "tests=passing", phi2: "tests=failing", winner: "tests=passing", sufficient: true  },
  { kind: "satisfy-evidence-gap",      phi: "security_scan",  requiredBelief: 0.8,                            sufficient: false },
  { kind: "commit-deferred-dependency", phi: "lead_review=done",                                              sufficient: false },
]
```

Each delta is the minimal residual change that would lift a specific blocker. `sufficient: true` means that single change is enough on its own.

---

## Scope of comparison (dated)

As of **April 24, 2026**, the comparison here refers to nearby workflow, policy, governance, and human-approval systems in their published/default forms.

Residual Runtime is not claiming those systems cannot model similar behavior. The narrower claim is that this kernel treats unresolved blockers as first-class typed runtime state and exposes structured unblock analysis over that state.

## Layer composition (no control-plane replacement)

Residual Runtime is designed to compose with existing control planes:

- orchestration chooses sequence,
- governance authorizes actors,
- policy engines enforce declared rules,
- approval systems decide when a human must intervene,
- Residual Runtime gates execution on unresolved submitted blocker state.

A stack can pass orchestration + governance + policy + approval and still be correctly blocked here if the submitted signals still contain unresolved blockers.

---

## How it works

The kernel only knows what gets submitted to it. It does not discover truth by itself.

That means the systems that observe the world — CI pipelines, scanners, approval workflows, other agents — need to be wired up to call `step()` when something changes. The kernel handles what those submissions mean for which actions can fire. The integrations themselves are your responsibility.

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

The engine accumulates **residual** — typed, lifecycled unfinished semantic work. An action is blocked whenever any atom in its `dependsOn` is under open tension, below evidence threshold, behind an unresolved deferred dependency, or permanently rejected. When residual clears, the action is approved.

Adjudication is final by default: once a loser atom is rejected, unresolved tension on the same pair cannot silently re-enter the residual. To explicitly reopen a previously resolved pair, callers must provide `input.reopenSignals` with `{ phi1, phi2, source, reason }` provenance.

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

## Domain-Fit Scenario Matrix

The strongest maintained workflow proofs are encoded in [`src/__tests__/domain-fit.test.ts`](src/__tests__/domain-fit.test.ts):

| Workflow family | World-state hazard | Expected runtime behavior |
|---|---|---|
| Finance settlement | Counterparty solvency dispute | Block settlement while tension is open; approve once adjudicated |
| Medical administration | Lab evidence threshold + deferred attending signoff | Block on both hazards; narrow blockers after evidence arrives; approve after deferred signoff materializes |
| Security/ops deployment | Post-approval risk dispute on a revocable deploy | Revoke previously approved revocable action when new unresolved blocker appears |
| Manufacturing safety control | Previously adjudicated losing branch | Permanently foreclose actions that depend on rejected safety branch |

These scenarios are intended to stay durable and executable rather than narrative-only examples.

---

## Fit Boundaries

Strong fit:
- Runtime execution gates where action validity depends on changing signals from multiple observers.
- Systems that need explicit blocker explanations (`whatWouldUnblock`) and deterministic revocation semantics.
- Agent or workflow surfaces where disputes, evidence thresholds, deferred commitments, or local resource conflicts are first-class.

Weak fit:
- Pure sequencing problems where a workflow engine already guarantees sufficient correctness.
- Static policy-only enforcement where preconditions are fully known and rarely change at runtime.
- Domains that cannot or will not feed timely evidence, constraints, adjudications, or approvals into `step()`.
- Use cases that need the kernel itself to discover or verify the real world rather than reason over submitted signals.

---

## Response Cost Expectations

- `step` is optimized for operational cadence: approved actions, canonical blocker certificates, residual counts, and event deltas.
- `get_state` is the inspection path: full state, full residual arrays, and verbose summaries for debugging/recovery.
- Response footprint scales with active conflict surfaces.
  More blocked actions increase `blocked[]`; more arbitration/conflict activity increases `events.*`; larger residual sets increase `get_state` payload size more than `step`.
- In tight loops, prefer frequent `step` calls and reserve `get_state` for checkpoints, troubleshooting, or handoff snapshots.

---

## Certificate Semantics

Blocked actions now return `blocked[]` entries with `certificates[]`. Each certificate has two distinct layers:

- **Hard semantics**: `next`, `sufficient`, and `permanent` describe strict unblock logic.
- **Advisory semantics**: `recommendations` carries acquisition moves (`observe`, `query`, `request_approval`, `run_check`) that suggest useful next work but do not claim logical sufficiency on their own.

This split lets callers separate "what is provably enough to unblock" from "what is operationally useful to try next."

---

## Deterministic Repair Runbook Proof

The repair layer compiles blocker certificates into typed `RepairIntent[]`, asks a bounded adapter to produce concrete observations, then replays the target action through `step()` until approved or the cycle budget is exhausted.

For the canonical deploy path (`DEPLOY_TO_PRODUCTION`), the runnable proof is:

```sh
npm run example:repair-runbook
```

The proof executes this fixed trace:

1. blocked action yields certificates (`adjudicate_tension`, `provide_evidence`, `satisfy_dependency`)
2. certificates compile into an ordered repair plan (`compileRepairPlan`)
3. adapter returns observation patches (adjudication + evidence + approval)
4. `runRepairCycle` feeds those patches into `step()` and rechecks admissibility
5. action is approved once blockers clear, with per-cycle trace preserved

Boundary: this layer does not discover truth, select external authorities, or replace workflow/policy/HITL systems. It executes a deterministic certificate-to-repair protocol over submitted signals.

---

## What's built

- **Core runtime** — `step()`, `naiveStep()`, `discharge()`, `lift()`, `filterBlocked()`, `blocks()`, `blockingAtoms()`
- **Counterfactual unblocking** — `whatWouldUnblock(action, residual, state) → UnblockAnalysis`
- **Knowledge-acquisition guidance** — blocker certificates include typed advisory acquisition moves for evidence, observation, query, and approval chasing workflows
- **AGM belief revision** — `contractBelief()` cascades minimal belief retraction on adjudication
- **Explicit reopen semantics** — resolved tensions reopen only through provenance-carrying `input.reopenSignals`; silent reopen attempts are surfaced as deterministic `reopenBlocked` events
- **Revocable actions** — approved revocable actions tracked; retracted if a later step would block them
- **Temporal residual** — `createdAt` on all residual items; `ageOf(item, nowMs)`; `TensionTimeoutPolicy` with `wallClockMs` for wall-clock timeouts
- **Safety policies** — deadlock detection, oscillation detection, overflow signaling, escalation (evidence gaps promoted to deferred), auto-adjudication, invalid adjudication reporting
- **Observability** — `diffStep()`, `computeMetrics()`, `summarizeTrace()`
- **Replay and persistence** — `appendStep()` / `replayLog()` with full state verification; NDJSON and in-memory adapters for runtime traces
- **CCP₀ formal verification** — `translateTrace()` + `verifyCcpTrace()`; wired into `replayLog({ ccpVerify: true })`
- **Pluggable transition engine** — swap the interpretation layer while the gate stays fixed
- **CLI demo** — `npm run cli` runs a local Ollama LLM through the gate end-to-end
- **MCP server** — stdio MCP tools: `new_session`, `list_sessions`, `get_state`, `step`, `suggest_repairs`, `update_session`
- **Objective-scoped sessions** — MCP sessions represent a work objective lifecycle (ticket/PR/incident), with persisted `objectiveType`, `objectiveRef`, `title`, `status`, `createdAt`, `closedAt`
- **SQLite-backed MCP state** — default MCP session persistence uses `sessions.sqlite` (WAL mode) with indexed append-only session events
- **Step provenance context** — MCP `step` accepts optional `context` (`branch`, `commitSha`, `worktreeId`, `actorId`) and persists it on replay events for auditability
- **Cross-session write-set conflict gating** — actions can declare optional `readSet`/`writeSet`; MCP step blocks branch/worktree-scoped write/write and read/write overlaps with deterministic conflict reasons and unblock guidance
- **Deterministic arbitration policies** — cross-session conflicts emit policy decisions (`serialize_first` or `branch_split_required`) with precedence metadata (conflict class + objective priority + tie-break) and integration-oriented unblock instructions

### MCP session semantics

- A `sessionId` should map to one objective lifecycle, not one branch.
- Session state is persisted in `sessions.sqlite` under the session root directory.
- Session root resolution order is: explicit `sessionRootDir` option, `RESIDUAL_SESSION_ROOT_DIR`, `./.residual-sessions`, `$HOME/.codex/residual-runtime/sessions`, then OS temp fallback.
- Branch/commit/worktree provenance (`context`) can change over a session, but any `step` that proposes `readSet`/`writeSet` claims must provide fresh context.
- When two active sessions share branch/worktree scope, `step` checks proposed actions against other sessions' held resource claims using `readSet`/`writeSet`.
- Overlapping `writeSet`/`writeSet` and `readSet`/`writeSet` resources are blocked as session conflicts and returned once in `events.sessionConflicts`.
- Arbitration decisions are returned once in `events.sessionArbitrations`, plus effective policy metadata in `events.sessionArbitrationPolicy`.
- `step` returns blocked-action guidance in `blocked[]` (`action` + typed `certificates[]`) and keeps `residualSummary` lean (counts + `hasOpenBlockers`).
- `certificates[].next` + `sufficient/permanent` are strict unblock semantics; `certificates[].recommendations` are advisory acquisition moves.
- `suggest_repairs` is the minimal planning surface: it compiles one blocked-action `certificates[]` payload into a deterministic repair plan without mutating session state.
- `step` accepts optional `input.reopenSignals` (`phi1`, `phi2`, `source`, `reason`) to explicitly reopen previously resolved tensions; silent reopen attempts are rejected and surfaced in `events.reopenBlocked`.
- `step` accepts optional `arbitrationPolicy` overrides (`enabled`, `defaultMode`, per-conflict mode overrides, objective priority map).
- Rollback/cutover flags are available via environment variables: `RESIDUAL_ARBITRATION_ENABLED`, `RESIDUAL_ARBITRATION_MODE`, `RESIDUAL_ARBITRATION_WRITE_WRITE_MODE`, `RESIDUAL_ARBITRATION_READ_WRITE_MODE`.
- `new_session` accepts optional objective metadata plus optional `seedInput`, `seedProposals`, and `stepOptions`.
- `update_session` can explicitly release held resource claims and/or mark a session `closed` when work is integrated.
- `get_state` remains the verbose inspection endpoint (`state`, full `residual`, verbose `residualSummary`) while preserving backward-compatible `sessionId`/`stepCount` fields; `list_sessions` also returns `sessionRootDir`.
- MCP tool arguments are strict-validated (unknown keys, blank IDs, malformed proposals/input, and invalid metadata combinations are rejected deterministically).
- Concurrent stale writers on the same session return a deterministic retry error: `Concurrent session update detected for \"<sessionId>\". Reload state and retry the step.`
- `npm run mcp:migrate -- --root <dir>` imports legacy `*.ndjson` session logs into SQLite.

---

### MCP implementation status (2026-04-26)

- [x] Stdio server entrypoint is wired (`npm run mcp`, `npm run mcp:dev`, and published bin `residual-mcp`).
- [x] Tool surface is implemented and discoverable: `new_session`, `list_sessions`, `get_state`, `step`, `suggest_repairs`, `update_session`.
- [x] Session persistence is SQLite-backed (`sessions.sqlite`, WAL mode, indexed event log).
- [x] Cross-session conflict gating is live for `write_write` and `read_write` overlaps.
- [x] Deterministic arbitration is live (`serialize_first`, `branch_split_required`) with per-step and env overrides.
- [x] Migration path from legacy NDJSON sessions is implemented (`npm run mcp:migrate`).
- [x] Coverage exists in [`src/__tests__/mcp.server.test.ts`](src/__tests__/mcp.server.test.ts) and [`src/__tests__/mcp.sessions.test.ts`](src/__tests__/mcp.sessions.test.ts).
- Boundary: coordination state is local filesystem SQLite; no external distributed lock service is used.

---

## Quick start

```sh
git clone <repo>
npm install
npm run example:failure-case   # canonical traced demo
npm run example:repair-runbook # deterministic certificate->repair->approval proof
npm run cli                    # interactive LLM demo (requires Ollama + llama3.1:8b)
npm run mcp                    # start MCP stdio server
npm run mcp:migrate -- --root ./.residual-sessions
npm test                       # build + run all tests
npm run ci                     # typecheck + test
```

## Local MCP install

Residual Runtime is designed to ship as a **local stdio MCP server** via npm, not as a hosted service.

Requirements:

- Node.js `>=22.13.0`
  This is the current tested runtime floor for the packaged local MCP.
- A local filesystem location for MCP session state (`.residual-sessions` by default)

Install and run:

```sh
npm install -g residual-runtime
residual-mcp
```

Point your MCP client at the `residual-mcp` binary. The server speaks stdio and persists session state locally; it does not require any remote service.

For swarm-style coordination, use `step` to claim scoped resources and `update_session` to release claims or close the session when the work is integrated.

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
