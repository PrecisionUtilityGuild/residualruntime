# Why Residual Runtime Exists

## The problem is not "can the agent act?"

Most production agent stacks already have answers for nearby questions:

- **Workflow runtimes** decide what step comes next and can pause/resume durable work.
- **Human-in-the-loop systems** pause sensitive tool calls for approve/edit/reject decisions.
- **Policy engines** decide whether a principal may take an action on a resource in context.
- **Governance toolkits** add identity, sandboxing, audit, runtime policy, SRE controls, and compliance evidence.
- **Runtime enforcement systems** monitor action streams and suppress, edit, delay, or correct unsafe behavior.

Those are real systems, not strawmen.

Residual Runtime exists for the narrower moment after those layers have done their jobs and the action is still not epistemically ready:

**the action may be allowed, correctly sequenced, and approved, but its submitted precondition signals are still unresolved.**

Examples:

- two observers disagree: `tests=passing` vs `tests=failing`
- evidence exists but does not meet threshold: `security_scan=0.6`, required `>= 0.8`
- a commitment exists but depends on unresolved upstream work: `staging_approved` waits on `lead_review=done`
- a previously plausible branch has been adjudicated against and must not silently return
- two sessions are about to write the same resource in the same branch/worktree scope

The product gap is not another "deny" button.

The gap is a runtime protocol for turning **not yet** into typed, owned, auditable next work.

---

## The breakthrough this project should optimize for

Residual Runtime should be understood as a **repair compiler for blocked execution**.

It takes a proposed action plus submitted world-state signals and produces one of three outcomes:

1. **Approve** the action because no declared dependency atom is blocked.
2. **Block temporarily** and return typed blocker certificates describing what would make the action admissible.
3. **Foreclose permanently** when the action depends on an atom that has already lost adjudication.

That third state matters. A runtime that only says "waiting" cannot distinguish:

- "the scan has not completed yet"
- "the scan completed and failed"
- "the scan result conflicts with another observer"
- "the branch this action needs was already rejected"

Residual Runtime keeps those cases separate.

That is the core usefulness: **blocked work becomes structured repair work instead of a dead end, retry loop, or vague approval request.**

---

## What the kernel actually does

The kernel reasons only over signals submitted to `step()`.

It does not discover truth, run CI, inspect production, contact reviewers, or decide which external system is authoritative. Connected systems must submit:

- constraints,
- evidence,
- adjudications,
- reopen signals,
- action proposals,
- and optional session resource claims.

Given those inputs, it:

1. Stores unfinished blocker state as **residual**.
2. Discharges residual deterministically as new evidence, adjudication, or dependency satisfaction arrives.
3. Blocks actions whose `dependsOn` atoms intersect active blockers or rejected atoms.
4. Emits typed events for escalation, deadlock, oscillation, invalid adjudication, reopen attempts, revocation, and session conflicts.
5. Returns typed unblock guidance that can drive the next acquisition step.

The smallest API expression of this idea is:

```ts
whatWouldUnblock(action, residual, state)
// ->
{
  permanent: false,
  deltas: [
    { kind: "adjudicate-tension", phi1: "tests=passing", phi2: "tests=failing", winner: "tests=passing", sufficient: false },
    { kind: "satisfy-evidence-gap", phi: "security_scan", requiredBelief: 0.8, sufficient: false },
    { kind: "commit-deferred-dependency", phi: "lead_review=done", sufficient: false },
  ]
}
```

The MCP-facing version is more operational: blocked actions carry **blocker certificates** with strict unblock semantics plus advisory acquisition moves.

```ts
{
  blockerType: "epistemic_evidence_gap",
  atoms: ["security_scan"],
  permanent: false,
  sufficient: false,
  next: { kind: "provide_evidence", phi: "security_scan", minBelief: 0.8 },
  recommendations: {
    semantics: "advisory",
    moves: [
      { kind: "run_check", target: "evidence:security_scan" },
      { kind: "query", target: "evidence:security_scan" },
    ],
  },
}
```

That split is important:

- `next`, `permanent`, and `sufficient` are strict runtime semantics.
- `recommendations` are useful acquisition moves, not proof obligations.

This prevents the doc from pretending the runtime knows more than it does.

---

## The research-informed boundary

The research landscape says the project should not position itself as a replacement for existing layers.

AgentSpec-style systems specify runtime constraints with triggers, predicates, and enforcement mechanisms. Agent Behavioral Contracts define preconditions, invariants, governance policies, and recovery mechanisms. POLARIS treats enterprise automation as typed plan synthesis plus governed execution. Microsoft Agent Governance Toolkit is a broad runtime-security and governance stack with policy, identity, sandboxing, SRE, compliance, and tool-control concerns. LangGraph and Temporal already provide durable execution, pause/resume, message passing, and human-in-the-loop patterns. OPA and Cedar already handle policy decisions over structured input.

Residual Runtime should therefore make a smaller and stronger claim:

**it standardizes the residual state between "blocked" and "resolved."**

That state is usually smeared across logs, tickets, workflow variables, approval comments, CI dashboards, retry loops, and human memory. This kernel packages it as:

- typed blockers,
- deterministic lifecycle transitions,
- permanent rejection memory,
- explicit reopen semantics,
- counterfactual unblock analysis,
- advisory acquisition moves,
- and replayable audit traces.

The closest theoretical relatives are truth-maintenance systems, AGM-style belief contraction, runtime verification/enforcement, concurrent constraint programming, and epistemic precondition logic. The implementation does not invent those fields. It borrows their useful shape for a practical execution gate.

---

## What "world-state unresolved" means here

In this codebase, unresolved blockers currently come in five operational forms:

| Type | Meaning | Hard-blocks actions? | Typical next move |
|---|---|---:|---|
| `Tension` | Two submitted claims conflict and neither has won | yes | adjudicate the pair |
| `EvidenceGap` | A belief threshold has not been met | yes | run/query evidence |
| `Deferred` | A dependency-backed commitment is not materialized yet | yes | satisfy dependency or request approval |
| `Rejected` | An atom already lost adjudication | yes, permanently | replan without that atom |
| `SessionConflict` | Another active session holds an overlapping read/write or write/write claim | yes | serialize, split scope, narrow resources, or integrate |

`Assumption` is different: it represents provisional belief with decay and does not hard-block actions by itself.

---

## The solution shape

Residual Runtime is useful when a system needs the following loop:

```text
observe signals
  -> preserve unresolved blocker state
  -> gate proposed actions
  -> emit precise blocker certificates
  -> acquire the missing decision/evidence/dependency/coordination
  -> replay and audit why the action did or did not execute
```

That loop is more concrete than "agent safety" and more useful than "approval workflow."

It gives callers a typed vocabulary for questions operators actually ask:

- What exactly is blocking this action?
- Is the block temporary or permanent?
- Would one change be sufficient, or are there multiple independent blockers?
- Should the next move be observation, evidence acquisition, approval, adjudication, replanning, or coordination?
- If a losing branch comes back, was it explicitly reopened or silently reintroduced?
- If two agents collide on the same resource, should one wait or should the work split?
- Can we replay the decision path later?

That is the project’s practical center.

---

## Where this composes cleanly

Residual Runtime sits beside existing control planes:

- **orchestration** decides sequence and durable waiting
- **policy** decides authorization against declared rules
- **governance** decides identity, privilege, tool, sandbox, compliance, and operational controls
- **human review** decides whether a person approves, edits, or rejects a proposed operation
- **Residual Runtime** decides whether submitted blocker state makes the action inadmissible right now, and what typed residual change would unblock it

A stack can say:

- "this action is the correct workflow step"
- "this caller is authorized"
- "this tool call passed policy"
- "a human approved the operation"

and Residual Runtime can still say:

- "not yet; the current submitted signals contain an unresolved tension"
- "not yet; the evidence threshold is not met"
- "not ever on this branch; that atom was rejected"
- "not in this session scope; another active writer owns that resource"

---

## Strong fit / weak fit

Strong fit:

- multi-observer systems where conflicting or incomplete signals must gate action
- CI/security/release flows where "approved" is not enough if evidence is stale or disputed
- medical, finance, safety, incident, and deployment workflows where blockers must be explicit and auditable
- agent coordination where local sessions can collide on branch/worktree resources
- systems that need machine-readable unblock guidance rather than prose explanations

Weak fit:

- pure sequencing problems where a workflow engine already captures the full correctness condition
- pure authorization where an OPA/Cedar-style policy decision is sufficient
- domains that cannot provide timely evidence, constraints, adjudications, approvals, or resource claims
- use cases that expect the kernel to discover true world state by itself
- broad agent-governance programs that need identity, sandboxing, compliance, threat detection, or distributed enforcement as the primary feature

---

## What this is not

**Not a source of truth.** It reasons over submitted signals.

**Not a workflow engine.** It does not own task routing, retries, sleep, timers, or long-running process orchestration.

**Not a general policy engine.** It does not replace OPA, Cedar, AgentSpec, ABC, or governance guardrails.

**Not an identity/security platform.** It does not implement RBAC, ABAC, zero-trust identity, sandboxing, supply-chain controls, or threat analytics.

**Not LLM-specific.** Any proposer can use it if it emits actions with dependency atoms and submits evidence/constraints/adjudications.

**Not magic certainty.** If nobody submits the missing signal, the runtime will preserve the block; it will not invent the answer.

---

## The honest novelty boundary

This project does not claim:

- a new planning logic,
- a new belief-revision calculus,
- a new verification theory,
- universal superiority over orchestration, policy, approval, or governance stacks,
- or automatic truth discovery.

It does claim a practical kernel pattern:

- unresolved blockers are first-class typed runtime state,
- action gating is deterministic over that state,
- blocked actions produce machine-readable repair objects and bounded repair plans,
- losing branches remain foreclosed unless explicitly reopened,
- revocable actions can be retracted when new blockers appear,
- session resource conflicts become typed coordination blockers,
- and replay can audit the decision path.

Those repair plans are compiled from blocker certificates plus adapter observations; they do not grant authority to decide which external system is true, only a deterministic way to process whichever signals your stack submits.

If the project becomes better, it should become better along that axis: **fewer vague blocks, more exact repair certificates.**

---

## References

- [AgentSpec: Customizable Runtime Enforcement for Safe and Reliable LLM Agents (arXiv 2503.18666)](https://arxiv.org/abs/2503.18666)
- [Agent Behavioral Contracts (arXiv 2602.22302)](https://arxiv.org/abs/2602.22302)
- [POLARIS: Typed Planning and Governed Execution for Agentic AI in Back-Office Automation](https://www.catalyzex.com/paper/polaris-typed-planning-and-governed-execution)
- [Microsoft Agent Governance Toolkit announcement](https://opensource.microsoft.com/blog/2026/04/02/introducing-the-agent-governance-toolkit-open-source-runtime-security-for-ai-agents/)
- [LangGraph human-in-the-loop docs](https://docs.langchain.com/oss/javascript/langchain/human-in-the-loop)
- [LangGraph durable execution docs](https://docs.langchain.com/oss/javascript/langgraph/durable-execution)
- [Temporal Workflow docs](https://docs.temporal.io/workflows)
- [Temporal Workflow message passing docs](https://docs.temporal.io/develop/typescript/workflows/message-passing)
- [Open Policy Agent docs](https://www.openpolicyagent.org/docs)
- [Cedar authorization docs](https://docs.cedarpolicy.com/auth/authorization.html)
- [OWASP Top 10 for Agentic Applications summary, Microsoft Security](https://www.microsoft.com/en-us/security/blog/2026/03/30/addressing-the-owasp-top-10-risks-in-agentic-ai-with-microsoft-copilot-studio/)
- [Knowledge of Preconditions Principle](https://researchtrend.ai/papers/1606.07525)
- [Doyle, A Truth Maintenance System](https://www.sciencedirect.com/science/article/pii/0004370279900080)
- [de Kleer, An Assumption-Based TMS](https://www.semanticscholar.org/paper/An-Assumption-Based-TMS-Kleer/ed3f9263e936a879092ad7a2bf27e0f94089ccd8)
- [Leucker and Schallhart, A Brief Account of Runtime Verification](https://www.isp.uni-luebeck.de/research/publications/brief-account-runtime-verification)
- [Edit Automata: Enforcement Mechanisms for Run-time Security Policies](https://collaborate.princeton.edu/en/publications/edit-automata-enforcement-mechanisms-for-run-time-security-polici/)
- [Shield synthesis](https://pmc.ncbi.nlm.nih.gov/articles/PMC6959420/)
- [Concurrent Constraint Programming, MIT Press](https://mitpress.mit.edu/9780262527996/concurrent-constraint-programming/)
