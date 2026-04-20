# Why Residual Runtime Exists

## The one thing no other system does

When an AI agent proposes an action, every existing runtime asks one of three questions:

1. **Is this caller authorised?** (identity governance — Microsoft Agent Governance Toolkit, Cordum)
2. **Is this the right step in the sequence?** (orchestration — LangGraph, CrewAI, AutoGen)
3. **Does this action match a rule I wrote in advance?** (rule enforcement — AgentSpec, ABC, POLARIS)

Residual Runtime asks a fourth question:

**Is the world coherent enough right now for this action to be valid?**

No other system in production or research answers this. That gap is what this kernel fills.

---

## What "world coherent enough" means concretely

An action depends on atoms — propositions about the world that must hold for the action to make sense. `DEPLOY_TO_PRODUCTION` depends on `tests=passing`, `security_scan`, `staging_approved`.

The world is not coherent enough when:

- **A tension is open** — two systems reported conflicting results (`tests=passing` vs `tests=failing`). Neither side has won. Acting on either is premature.
- **Evidence hasn't arrived** — `security_scan` needs belief ≥ 0.8. The scan came back at 0.6. The atom is not established.
- **A commitment is deferred** — `staging_approved` is waiting on `lead_review=done`. The dependency hasn't resolved.

In those conditions, the action is blocked. Not because a rule says so. Because the epistemic state of the world, right now, does not support it.

When the world resolves — the tension adjudicates, the evidence arrives, the commitment satisfies — the block lifts automatically.

---

## Why the other approaches don't cover this

**Orchestration frameworks** (LangGraph, CrewAI) manage task order. Their state is a data bag threaded between nodes. Nothing in LangGraph prevents an agent from calling an API while a dispute about the preconditions for that call is still open. You'd have to write a guard node yourself — and the framework gives you no vocabulary for disputes, evidence thresholds, or deferred commitments.

**Rule-based enforcement** (AgentSpec, ABC, POLARIS) enforces what developers write down. AgentSpec requires you to author a trigger and predicate for every constraint you care about. ABC requires upfront specification of preconditions and invariants. These are serious systems — and they work when you can anticipate the constraints.

The problem: you cannot always anticipate blocking conditions at authoring time. A tension emerges at runtime because two systems reported conflicting results. An evidence gap appears because a scan API returned a lower score than expected. A deferred dependency stalls because a human approval is late. None of these are conditions you wrote a rule for. Residual Runtime catches them anyway — because blocking is derived from live epistemic state, not declared in advance.

**The honest caveat:** the kernel only knows what gets submitted to it. The CI pipeline, the scanner, the approval workflow — each one needs to be wired up to call `step()` when something changes. That integration work is real. What you don't have to do is write rules that anticipate every combination of conditions. What you do have to do is connect the systems that observe the world.

**Identity governance** (Microsoft Agent Governance Toolkit, MI9, IBM) answers "can this caller do this?" That is a necessary layer. It is not this layer. A caller can be fully authorised, at the right step, passing every declared rule — and still be acting on an unresolved world-state.

---

## The one thing this enables that nothing else can

`whatWouldUnblock(action, residual, state)` returns the exact minimal set of changes that would make a blocked action valid:

```ts
[
  { kind: "adjudicate-tension",       phi1: "tests=passing", phi2: "tests=failing", winner: "tests=passing", sufficient: true },
  { kind: "satisfy-evidence-gap",     phi: "security_scan",  requiredBelief: 0.8,                            sufficient: false },
  { kind: "commit-deferred-dependency", phi: "lead_review=done",                                             sufficient: false },
]
```

Each delta says: if you make this change, blocking is lifted. `sufficient: true` means this single change is enough on its own.

No other system can answer this. The reason: answering it requires a typed, invertible residual structure. Rule-based systems can tell you "blocked." They cannot tell you "adjudicate this tension in favour of φ₁ and the action becomes valid" — because they have no residual to invert.

---

## What this is not

**Not a replacement for orchestration.** LangGraph routes tasks. This blocks invalid actions. They compose — this sits between the LLM and the execution layer.

**Not a rule engine.** You do not write preconditions or invariants. If you can articulate your constraints in advance, AgentSpec or ABC are better tools. This is for blocking conditions that emerge from runtime state.

**Not an identity or security tool.** It does not do RBAC, ABAC, or threat detection.

**Not LLM-specific.** The kernel is agnostic about what generates proposals. A symbolic planner, a rule engine, or an LLM all interact with it the same way — they submit typed proposals, and the gate decides.

---

## The formal grounding (brief)

The kernel operationalises the **Knowledge of Preconditions Principle** (arXiv 1606.07525): if φ is necessary for an action, then *knowing* φ holds is also necessary. An action cannot execute while its precondition atoms are under open tension, below evidence threshold, or behind an unresolved deferred dependency.

Belief revision follows **AGM contraction**: resolving a tension retracts the loser's belief and cascades minimally to dependent beliefs.

Trace correctness is verified against **CCP₀** (Concurrent Constraint Programming, Saraswat 1990): every approved action corresponds to a successful `ask` on the monotone store; every blocked action to a failed `ask`. `replayLog({ ccpVerify: true })` asserts this on every replay.

---

## References

- [AgentSpec: Customizable Runtime Enforcement for Safe and Reliable LLM Agents (arXiv 2503.18666)](https://arxiv.org/abs/2503.18666)
- [Agent Behavioral Contracts (arXiv 2602.22302)](https://arxiv.org/abs/2602.22302)
- [POLARIS: Typed Planning and Governed Execution (arXiv 2601.11816)](https://arxiv.org/abs/2601.11816)
- [Introducing the Agent Governance Toolkit (Microsoft, April 2026)](https://opensource.microsoft.com/blog/2026/04/02/introducing-the-agent-governance-toolkit-open-source-runtime-security-for-ai-agents/)
- [MI9: An Integrated Runtime Governance Framework (arXiv 2508.03858)](https://arxiv.org/abs/2508.03858)
- [Knowledge of Preconditions Principle (arXiv 1606.07525)](https://arxiv.org/abs/1606.07525)
- [Concurrent Constraint Programming (Saraswat, POPL 1990)](https://dl.acm.org/doi/10.1145/96709.96733)
- [AGM Belief Revision, Semantically (2025)](https://iccl.inf.tu-dresden.de/w/images/b/b2/FRS-TOCL-2025-AGMsemantically.pdf)
- [The Missing Layer in Agentic AI (O'Reilly)](https://www.oreilly.com/radar/the-missing-layer-in-agentic-ai/)
- [Stanford AI Index 2026](https://www.kiteworks.com/cybersecurity-risk-management/stanford-ai-index-2026-agentic-ai-security-governance/)
