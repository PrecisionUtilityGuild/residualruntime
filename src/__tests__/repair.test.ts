import test from "node:test";
import assert from "node:assert/strict";
import {
  compileRepairPlan,
  createSeededFakeRepairAdapter,
  runRepairCycle,
} from "../runtime/repair";
import {
  DEPLOY_TO_PRODUCTION_ACTION,
  createDeployRepairSeed,
} from "../examples/deployRepairFixtures";
import { createEmptyResidual, createInitialState } from "../runtime/model";
import { blockerCertificates } from "../runtime/predicates";
import type { Action, BlockerCertificate, RepairAdapter } from "../runtime/model";

const action = (type: string, dependsOn: string[]): Action => ({
  kind: "action",
  type,
  dependsOn,
});

test("compileRepairPlan: maps all blocker families into a stable ordered repair plan", () => {
  const certificates: BlockerCertificate[] = [
    {
      blockerId: "tension:ship_fast|full_review",
      blockerType: "epistemic_tension",
      atoms: ["ship_fast"],
      permanent: false,
      sufficient: false,
      recommendations: {
        semantics: "advisory",
        moves: [{ kind: "query", target: "source-of-truth:full_review|ship_fast", reason: "Gather evidence." }],
      },
      next: {
        kind: "adjudicate_tension",
        phi1: "ship_fast",
        phi2: "full_review",
        options: [
          { winner: "ship_fast", sufficient: true },
          { winner: "full_review", sufficient: false },
        ],
      },
    },
    {
      blockerId: "rejected:forbidden_change",
      blockerType: "epistemic_rejected",
      atoms: ["forbidden_change"],
      permanent: true,
      sufficient: true,
      recommendations: {
        semantics: "advisory",
        moves: [{ kind: "query", target: "plan:alternatives:forbidden_change", reason: "Choose a safe alternative." }],
      },
      next: {
        kind: "replan_without_rejected_atom",
        rejectedAtoms: ["forbidden_change"],
      },
    },
    {
      blockerId: "session:write_write|src/runtime/repair.ts|session-2",
      blockerType: "session_coordination",
      atoms: ["src/runtime/repair.ts"],
      permanent: false,
      sufficient: false,
      recommendations: {
        semantics: "advisory",
        moves: [{ kind: "observe", target: "resource:src/runtime/repair.ts", reason: "Wait for the other session to release the file." }],
      },
      next: {
        kind: "coordinate_session",
        conflictType: "write_write",
        resource: "src/runtime/repair.ts",
        otherSessionId: "session-2",
        mode: "serialize_first",
        outcome: "serialize_wait",
        unblock: [{ kind: "wait_for_other_session", detail: "Retry after session-2 completes." }],
      },
    },
    {
      blockerId: "evidence_gap:lab_result",
      blockerType: "epistemic_evidence_gap",
      atoms: ["lab_result"],
      permanent: false,
      sufficient: true,
      recommendations: {
        semantics: "advisory",
        moves: [{ kind: "run_check", target: "evidence:lab_result", reason: "Run the missing check." }],
      },
      next: {
        kind: "provide_evidence",
        phi: "lab_result",
        minBelief: 0.92,
      },
    },
    {
      blockerId: "deferred:attending_signoff",
      blockerType: "epistemic_deferred",
      atoms: ["attending_signoff"],
      permanent: false,
      sufficient: true,
      recommendations: {
        semantics: "advisory",
        moves: [{ kind: "request_approval", target: "approval:attending_signoff", reason: "Request the missing approval." }],
      },
      next: {
        kind: "satisfy_dependency",
        phi: "attending_signoff",
      },
    },
  ];

  const plan = compileRepairPlan(certificates);

  assert.deepEqual(plan.trace.blockerIds, [
    "deferred:attending_signoff",
    "evidence_gap:lab_result",
    "rejected:forbidden_change",
    "session:write_write|src/runtime/repair.ts|session-2",
    "tension:ship_fast|full_review",
  ]);
  assert.deepEqual(
    plan.intents.map((intent) => intent.strict.kind),
    [
      "satisfy_dependency",
      "provide_evidence",
      "replan_without_rejected_atom",
      "coordinate_session",
      "adjudicate_tension",
    ]
  );
  assert.deepEqual(
    plan.intents.map((intent) => intent.trace.stableOrder),
    [0, 1, 2, 3, 4]
  );
});

test("compileRepairPlan: permanent rejected blockers compile to replan-only intents", () => {
  const plan = compileRepairPlan([
    {
      blockerId: "rejected:prod_db",
      blockerType: "epistemic_rejected",
      atoms: ["prod_db"],
      permanent: true,
      sufficient: true,
      recommendations: {
        semantics: "advisory",
        moves: [{ kind: "query", target: "plan:alternatives:prod_db", reason: "Select an alternate plan." }],
      },
      next: {
        kind: "replan_without_rejected_atom",
        rejectedAtoms: ["prod_db"],
      },
    },
  ]);

  assert.equal(plan.summary.requiresReplan, true);
  assert.equal(plan.summary.permanentBlockers, 1);
  assert.equal(plan.summary.actionableIntents, 0);
  assert.equal(plan.intents[0].kind, "replan");
  assert.equal(plan.intents[0].resolution, "replan_required");
  assert.deepEqual(plan.trace.permanentBlockerIds, ["rejected:prod_db"]);
});

test("compileRepairPlan: keeps strict runtime directives separate from advisory acquisition moves", () => {
  const plan = compileRepairPlan([
    {
      blockerId: "evidence_gap:artifact",
      blockerType: "epistemic_evidence_gap",
      atoms: ["artifact"],
      permanent: false,
      sufficient: true,
      recommendations: {
        semantics: "advisory",
        moves: [{ kind: "query", target: "evidence:artifact", reason: "Look for existing evidence." }],
      },
      next: {
        kind: "provide_evidence",
        phi: "artifact",
        minBelief: 0.7,
      },
    },
  ]);

  const intent = plan.intents[0];
  assert.equal(intent.kind, "repair");
  assert.equal(intent.resolution, "single_step");
  assert.equal(intent.strict.kind, "provide_evidence");
  assert.ok(!("moves" in intent.strict), "strict directive should not embed advisory acquisition moves");
  assert.equal(intent.advisory.semantics, "advisory");
  assert.ok(!("kind" in intent.advisory), "advisory payload should stay separate from strict repair directives");
  assert.deepEqual(intent.advisory.moves, [
    { kind: "query", target: "evidence:artifact", reason: "Look for existing evidence." },
  ]);
});

test("compileRepairPlan: insufficient blockers remain multi-step repairs", () => {
  const plan = compileRepairPlan([
    {
      blockerId: "session:read_write|README.md|session-9",
      blockerType: "session_coordination",
      atoms: ["README.md"],
      permanent: false,
      sufficient: false,
      recommendations: {
        semantics: "advisory",
        moves: [{ kind: "observe", target: "resource:README.md", reason: "Wait for the conflicting session." }],
      },
      next: {
        kind: "coordinate_session",
        conflictType: "read_write",
        resource: "README.md",
        otherSessionId: "session-9",
        mode: "branch_split_required",
        outcome: "branch_split_required",
        unblock: [{ kind: "split_scope", detail: "Create a separate branch or narrower claim." }],
      },
    },
  ]);

  assert.equal(plan.summary.singleStepIntents, 0);
  assert.equal(plan.summary.multiStepIntents, 1);
  assert.equal(plan.intents[0].kind, "repair");
  assert.equal(plan.intents[0].resolution, "multi_step");
  assert.equal(plan.intents[0].strict.kind, "coordinate_session");
});

test("runRepairCycle: executes deterministic adapter observations and resolves target action", () => {
  const adapter = createSeededFakeRepairAdapter({
    adapterId: "ci-adapter",
    seed: 100,
    script: {
      run_check: [
        {
          inputPatch: { evidence: { risk_score: 0.91 } },
          contextPatch: { actorId: "ci-bot" },
          note: "scanner pass",
        },
      ],
    },
  });

  const result = runRepairCycle({
    state: createInitialState(),
    residual: {
      ...createEmptyResidual(),
      evidenceGaps: [
        {
          kind: "evidence_gap",
          phi: "risk_score",
          threshold: 0.8,
        },
      ],
    },
    targetAction: action("DEPLOY_TO_PRODUCTION", ["risk_score"]),
    adapter,
    maxCycles: 2,
    initialContext: { branch: "main" },
  });

  assert.equal(result.status, "resolved");
  assert.equal(result.targetActionApproved, true);
  assert.equal(result.cycles.length, 1);
  assert.equal(result.cycles[0].generatedInput.evidence?.risk_score, 0.91);
  assert.equal(
    result.cycles[0].stepResult?.replay.input.evidence?.risk_score,
    0.91
  );
  assert.equal(result.context?.branch, "main");
  assert.equal(result.context?.actorId, "ci-bot");
  assert.equal(result.cycles[0].observations[0].provenance.adapterId, "ci-adapter");
  assert.equal(result.cycles[0].observations[0].provenance.capability, "run_check");
  assert.equal(result.cycles[0].observations[0].provenance.source, "strict");
});

test("runRepairCycle: permanent blockers fail deterministically before adapter execution", () => {
  const result = runRepairCycle({
    state: {
      ...createInitialState(),
      rejected: ["forbidden_atom"],
    },
    residual: createEmptyResidual(),
    targetAction: action("DEPLOY_TO_PRODUCTION", ["forbidden_atom"]),
    adapter: createSeededFakeRepairAdapter({ adapterId: "noop-adapter" }),
    maxCycles: 3,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.failureCode, "permanent_blocker");
  assert.equal(result.cycles.length, 1);
  assert.equal(result.cycles[0].stepResult, undefined);
});

test("runRepairCycle: missing strict capabilities fail deterministically", () => {
  const limitedAdapter: RepairAdapter = {
    adapterId: "limited-adapter",
    capabilities: {
      query: () => [],
      run_check: () => [],
      request_approval: () => [],
      observe: () => [],
      coordinate: () => [],
    },
  };

  const result = runRepairCycle({
    state: createInitialState(),
    residual: {
      ...createEmptyResidual(),
      tensions: [{ kind: "tension", phi1: "ship_fast", phi2: "full_review" }],
    },
    targetAction: action("DEPLOY_TO_PRODUCTION", ["ship_fast"]),
    adapter: limitedAdapter,
    maxCycles: 1,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.failureCode, "missing_capability");
  assert.match(result.failureMessage ?? "", /adjudicate/);
  assert.equal(result.cycles.length, 1);
  assert.equal(result.cycles[0].stepResult, undefined);
});

test("runRepairCycle: does not invent evidence, adjudications, or approvals", () => {
  const result = runRepairCycle({
    state: createInitialState(),
    residual: {
      ...createEmptyResidual(),
      tensions: [{ kind: "tension", phi1: "ship_fast", phi2: "full_review" }],
      evidenceGaps: [{ kind: "evidence_gap", phi: "risk_score", threshold: 0.9 }],
      deferred: [
        {
          kind: "deferred",
          constraint: { type: "Prop", phi: "lead_signoff" },
          dependencies: ["manager_online"],
        },
      ],
    },
    targetAction: action("DEPLOY_TO_PRODUCTION", [
      "ship_fast",
      "risk_score",
      "lead_signoff",
    ]),
    adapter: createSeededFakeRepairAdapter({ adapterId: "empty-adapter" }),
    maxCycles: 1,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.failureCode, "max_cycles_exceeded");
  assert.equal(result.cycles.length, 1);
  assert.deepEqual(result.cycles[0].generatedInput, {});
  assert.deepEqual(result.cycles[0].generatedProposals, []);
  assert.deepEqual(result.cycles[0].stepResult?.replay.input, {});
});

test("golden deploy: initial blocker certificates are tension + evidence-gap + deferred", () => {
  const seeded = createDeployRepairSeed();
  const certificates = blockerCertificates(
    DEPLOY_TO_PRODUCTION_ACTION,
    seeded.residual,
    seeded.state
  );

  assert.deepEqual(
    certificates.map((certificate) => certificate.blockerType),
    ["epistemic_deferred", "epistemic_evidence_gap", "epistemic_tension"]
  );

  const deferred = certificates.find(
    (certificate) => certificate.blockerType === "epistemic_deferred"
  )!;
  assert.equal(deferred.next.kind, "satisfy_dependency");
  assert.equal(deferred.next.phi, "staging_approved");
  assert.equal(deferred.recommendations.semantics, "advisory");
  assert.ok(
    deferred.recommendations.moves.some((move) => move.kind === "request_approval")
  );

  const evidence = certificates.find(
    (certificate) => certificate.blockerType === "epistemic_evidence_gap"
  )!;
  assert.equal(evidence.next.kind, "provide_evidence");
  assert.equal(evidence.next.phi, "security_scan");
  assert.equal(evidence.next.minBelief, 0.8);
  assert.equal(evidence.recommendations.semantics, "advisory");
  assert.ok(
    evidence.recommendations.moves.some((move) => move.kind === "run_check")
  );

  const tension = certificates.find(
    (certificate) => certificate.blockerType === "epistemic_tension"
  )!;
  assert.equal(tension.next.kind, "adjudicate_tension");
  assert.equal(tension.next.phi1, "tests=passing");
  assert.equal(tension.next.phi2, "tests=failing");
  assert.equal(tension.recommendations.semantics, "advisory");
  assert.ok(
    tension.recommendations.moves.some((move) => move.kind === "query")
  );
  assert.ok(
    tension.recommendations.moves.some((move) => move.kind === "observe")
  );
});

test("golden deploy: scripted repair cycle drives blocked deploy to approved without prompts", () => {
  const seeded = createDeployRepairSeed();
  const adapter = createSeededFakeRepairAdapter({
    adapterId: "golden-deploy-adapter",
    seed: 500,
    script: {
      request_approval: [
        {
          inputPatch: {
            constraints: [{ type: "Prop", phi: "lead_review=done" }],
          },
          contextPatch: { actorId: "approval-bot" },
          note: "lead review complete",
        },
      ],
      run_check: [
        {
          inputPatch: { evidence: { security_scan: 0.93 } },
          contextPatch: { commitSha: "abc1234" },
          note: "security scan passed",
        },
      ],
      adjudicate: [
        {
          inputPatch: {
            adjudications: [
              {
                phi1: "tests=passing",
                phi2: "tests=failing",
                winner: "tests=passing",
              },
            ],
          },
          contextPatch: { actorId: "ci-arbiter" },
          note: "tests adjudicated",
        },
      ],
    },
  });

  const result = runRepairCycle({
    state: seeded.state,
    residual: seeded.residual,
    targetAction: DEPLOY_TO_PRODUCTION_ACTION,
    adapter,
    maxCycles: 4,
    initialContext: { branch: "main" },
  });

  assert.equal(result.status, "resolved");
  assert.equal(result.targetActionApproved, true);
  assert.equal(result.cycles.length, 2, "deferred dependency should require a follow-up cycle");
  assert.deepEqual(
    result.cycles[0].plan.intents.map((intent) => intent.strict.kind),
    ["satisfy_dependency", "provide_evidence", "adjudicate_tension"]
  );
  assert.ok(
    result.cycles[0].stepResult?.actionsBlocked.some(
      (blocked) => blocked.type === "DEPLOY_TO_PRODUCTION"
    ),
    "first cycle should still block while deferred materialization is pending"
  );
  assert.ok(
    result.cycles[1].stepResult?.actionsApproved.some(
      (approved) => approved.type === "DEPLOY_TO_PRODUCTION"
    ),
    "second cycle should approve deploy"
  );

  assert.deepEqual(result.cycles[0].generatedInput.evidence, {
    security_scan: 0.93,
  });
  assert.deepEqual(result.cycles[0].generatedInput.constraints, [
    { type: "Prop", phi: "lead_review=done" },
  ]);
  assert.deepEqual(result.cycles[0].generatedInput.adjudications, [
    {
      phi1: "tests=passing",
      phi2: "tests=failing",
      winner: "tests=passing",
    },
  ]);
  assert.deepEqual(result.cycles[0].generatedProposals, []);
  assert.equal(
    result.cycles[0].stepResult?.replay.input.evidence?.security_scan,
    0.93
  );
  assert.equal(result.context?.branch, "main");
  assert.equal(result.context?.commitSha, "abc1234");
  assert.equal(result.context?.actorId, "ci-arbiter");

  const traceJson = JSON.stringify(result.cycles).toLowerCase();
  assert.equal(
    /ask the user|system_prompt|ollama/.test(traceJson),
    false,
    "repair trace should not depend on interactive LLM/user prompting"
  );
});
