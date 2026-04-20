/**
 * Multi-Agent Residual Sharing: ICU Critical Care Triage
 *
 * Scenario: A patient arrives in the ICU with a suspected aortic dissection.
 * Three agents share a single residual. Each proposes actions that depend on
 * contested clinical atoms. The runtime enforces that no agent executes on
 * unresolved ground — even under time pressure.
 *
 * Agents:
 *   diagnostics — reads labs, interprets imaging, proposes blood-type verdicts
 *   pharmacy    — prepares and clears drug orders
 *   surgeon     — plans and executes the operative intervention
 *
 * Key tensions:
 *   T1: blood_type=A+ vs blood_type=O-
 *       Two rapid tests returned conflicting results. Transfusion hangs on this.
 *   T2: heparin_safe vs heparin_contraindicated
 *       Suspected HIT. Pharmacy and surgery both depend on heparin clearance.
 *
 * Key evidence gap:
 *   E1: kidney_function_ok (threshold 0.7)
 *       Contrast dye for imaging requires renal clearance. Below threshold =
 *       no CT angiogram, no definitive dissection grade.
 *
 * The runtime prevents:
 *   - Pharmacy cross-matching blood before blood type is resolved
 *   - Surgery anticoagulating before heparin clearance
 *   - Imaging ordering contrast before renal function is confirmed
 *   - Any agent acting on the losing branch after adjudication
 *
 * This is the architecture §9.2 claim made executable: the runtime's enforcement
 * is independent of which agent owns interpretation. All three agents are blocked
 * or unblocked by the same shared residual state.
 */

import {
  step,
  createEmptyResidual,
  createInitialState,
  type State,
  type Residual,
  type StepResult,
} from "../index";

// ── Shared residual ───────────────────────────────────────────────────────────
// All agents read and write through the same (state, residual) pair.
// In a real system this would be a shared store; here it is passed by reference
// across agent steps to demonstrate the shared-residual contract.

interface AgentStep {
  agent: string;
  result: StepResult;
}

function agentStep(
  agent: string,
  state: State,
  residual: Residual,
  params: Omit<Parameters<typeof step>[0], "state" | "residual">
): AgentStep {
  return { agent, result: step({ state, residual, ...params }) };
}

function printStep(label: string, s: AgentStep): void {
  const { actionsApproved, actionsBlocked, softBlocked, stateNext, residualNext } = s.result;
  const approved = actionsApproved.map((a) => a.type).join(", ") || "(none)";
  const blocked = actionsBlocked.map((a) => a.type).join(", ") || "(none)";
  const soft = softBlocked.map((a) => `${a.action.type}[soft]`).join(", ");
  const tensions = residualNext.tensions.map((t) => `${t.phi1}⟷${t.phi2}`).join(", ") || "(none)";
  const gaps = residualNext.evidenceGaps.map((g) => `${g.phi}<${g.threshold}`).join(", ") || "(none)";
  const rejected = stateNext.rejected.join(", ") || "(none)";

  console.log(`\n  [${s.agent.toUpperCase()}] ${label}`);
  console.log(`    approved : ${approved}`);
  console.log(`    blocked  : ${blocked}${soft ? ` | ${soft}` : ""}`);
  console.log(`    residual : tensions=[${tensions}]  gaps=[${gaps}]`);
  console.log(`    rejected : ${rejected}`);
}

// ── Scenario ──────────────────────────────────────────────────────────────────

export function runIcuTriageScenario(): void {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║   Multi-Agent Residual Sharing: ICU Critical Care Triage    ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log("\nPatient: suspected aortic dissection. BP 60/40. Clock is running.");
  console.log("Three agents. One shared residual. Nothing fires until the ground is clear.\n");

  let state = createInitialState();
  let residual = createEmptyResidual();

  // ── TICK 1: Diagnostics opens the disputes ────────────────────────────────
  console.log("━━━ TICK 1: Labs return conflicting blood-type reads ━━━━━━━━━━━━");
  console.log("  Rapid test A: A+. Rapid test B: O-. Both flagged as high-confidence.");
  console.log("  Diagnostics enters both tensions. Renal function gap opened (creatinine pending).");

  const t1 = agentStep("diagnostics", state, residual, {
    input: {
      constraints: [
        // Blood type dispute — two conflicting rapid assays
        { type: "Unresolved", phi1: "blood_type=A+", phi2: "blood_type=O-" },
        // Heparin safety dispute — HIT screen pending
        { type: "Unresolved", phi1: "heparin_safe", phi2: "heparin_contraindicated" },
        // Renal function must clear 0.7 before contrast imaging
        { type: "RequireEvidence", phi: "kidney_function_ok", threshold: 0.7 },
      ],
    },
    proposals: [
      // Diagnostics wants to order CT angiogram with contrast — needs renal clearance
      { kind: "action", type: "ORDER_CT_ANGIOGRAM_CONTRAST", dependsOn: ["kidney_function_ok"] },
    ],
  });
  state = t1.result.stateNext;
  residual = t1.result.residualNext;
  printStep("enters both tensions + renal gap, proposes CT angiogram", t1);

  // ── TICK 2: Pharmacy and Surgery both blocked ─────────────────────────────
  console.log("\n━━━ TICK 2: Pharmacy and Surgery act on shared residual ━━━━━━━━━");
  console.log("  Pharmacy wants to cross-match blood. Needs resolved blood type.");
  console.log("  Surgery wants to anticoagulate. Needs heparin clearance.");
  console.log("  Both agents see the same residual. Both are blocked.");

  const t2pharmacy = agentStep("pharmacy", state, residual, {
    input: {},
    proposals: [
      // Cross-match requires knowing the actual blood type
      { kind: "action", type: "CROSSMATCH_BLOOD_A+", dependsOn: ["blood_type=A+"] },
      { kind: "action", type: "CROSSMATCH_BLOOD_O-", dependsOn: ["blood_type=O-"] },
      // Drug prep can proceed — no residual dependency
      { kind: "action", type: "PREP_VASOPRESSORS", dependsOn: [] },
    ],
  });
  // Pharmacy's step doesn't change shared state — each agent reads the current
  // (state, residual) and proposes; the host loop decides whose output advances state.
  // Here we show both agents reading the same residual in the same tick.

  const t2surgery = agentStep("surgeon", state, residual, {
    input: {},
    proposals: [
      // Anticoagulation requires heparin clearance
      { kind: "action", type: "ADMINISTER_HEPARIN", dependsOn: ["heparin_safe"] },
      // Operative prep doesn't depend on contested atoms
      { kind: "action", type: "PREP_OR_SUITE", dependsOn: [] },
    ],
  });

  printStep("cross-match blocked (blood type open), vasopressors clear", t2pharmacy);
  printStep("heparin blocked (HIT screen open), OR prep clear", t2surgery);

  // Advance shared state: merge approved actions from this tick.
  // Both agents approved their non-contested actions; we take the last clean state.
  // (In a real host, you'd merge stateNext fields; here the non-contested actions
  //  don't touch residual so stateNext is identical between the two.)
  state = t2surgery.result.stateNext;
  residual = t2surgery.result.residualNext;

  // ── TICK 3: Renal labs return — partial evidence ───────────────────────────
  console.log("\n━━━ TICK 3: Creatinine back — borderline renal function ━━━━━━━━━");
  console.log("  eGFR 58. Creatinine 1.4. Borderline. Evidence = 0.62. Threshold = 0.70.");
  console.log("  Diagnostics still cannot order contrast CT. Evidence gap persists.");

  const t3 = agentStep("diagnostics", state, residual, {
    input: {
      // Renal evidence comes in but below threshold
      evidence: { kidney_function_ok: 0.62 },
    },
    proposals: [
      { kind: "action", type: "ORDER_CT_ANGIOGRAM_CONTRAST", dependsOn: ["kidney_function_ok"] },
      // No-contrast MRA is independent — no residual dependency
      { kind: "action", type: "ORDER_MRA_NO_CONTRAST", dependsOn: [] },
    ],
  });
  state = t3.result.stateNext;
  residual = t3.result.residualNext;
  printStep("contrast CT still blocked (0.62 < 0.70), MRA approved", t3);

  // ── TICK 4: HIT screen returns negative — heparin cleared ─────────────────
  console.log("\n━━━ TICK 4: HIT screen negative — adjudication: heparin_safe wins ━");
  console.log("  Senior hematologist adjudicates: heparin_safe.");
  console.log("  Surgery can now anticoagulate. Pharmacy: heparin_contraindicated foreclosed.");

  const t4 = agentStep("surgeon", state, residual, {
    input: {
      adjudications: [
        { phi1: "heparin_safe", phi2: "heparin_contraindicated", winner: "heparin_safe" },
      ],
    },
    proposals: [
      { kind: "action", type: "ADMINISTER_HEPARIN", dependsOn: ["heparin_safe"] },
      { kind: "action", type: "BEGIN_BYPASS_PREP", dependsOn: ["heparin_safe"] },
    ],
  });
  state = t4.result.stateNext;
  residual = t4.result.residualNext;
  printStep("heparin adjudicated safe → both surgical actions approved", t4);

  // ── TICK 5: Pharmacy tries the contraindicated path — permanently blocked ──
  console.log("\n━━━ TICK 5: Pharmacy tries to use alternative anticoag ━━━━━━━━━━━");
  console.log("  Pharmacy agent (stale context) proposes argatroban (HIT alternative).");
  console.log("  Its proposal depends on heparin_contraindicated — which is now rejected.");
  console.log("  Permanent foreclosure: action blocked even though it's a 'new' proposal.");

  const t5 = agentStep("pharmacy", state, residual, {
    input: {},
    proposals: [
      // Argatroban is the HIT alternative — only valid if heparin IS contraindicated
      { kind: "action", type: "PREPARE_ARGATROBAN", dependsOn: ["heparin_contraindicated"] },
      // Protamine (heparin reversal) depends on heparin_safe — should be approved
      { kind: "action", type: "STOCK_PROTAMINE_SULFATE", dependsOn: ["heparin_safe"] },
    ],
  });
  state = t5.result.stateNext;
  residual = t5.result.residualNext;
  printStep("argatroban permanently blocked (contraindicated path foreclosed), protamine approved", t5);

  // ── TICK 6: Blood type adjudicated — type O- wins (universal donor) ────────
  console.log("\n━━━ TICK 6: Blood bank re-runs sample — blood_type=O- confirmed ━━");
  console.log("  Lab director adjudicates: O- (universal donor — always the safe call).");
  console.log("  Pharmacy can now cross-match. A+ cross-match is permanently foreclosed.");

  const t6 = agentStep("pharmacy", state, residual, {
    input: {
      adjudications: [
        { phi1: "blood_type=A+", phi2: "blood_type=O-", winner: "blood_type=O-" },
      ],
    },
    proposals: [
      { kind: "action", type: "CROSSMATCH_BLOOD_O-", dependsOn: ["blood_type=O-"] },
      { kind: "action", type: "RELEASE_2_UNITS_PRBCs", dependsOn: ["blood_type=O-"] },
    ],
  });
  state = t6.result.stateNext;
  residual = t6.result.residualNext;
  printStep("blood type resolved O- → cross-match and transfusion approved", t6);

  // ── TICK 7: Diagnostics tries A+ path after adjudication ──────────────────
  console.log("\n━━━ TICK 7: Junior resident still proposes A+ cross-match ━━━━━━━━");
  console.log("  Diagnostics agent (different instance, didn't see tick 6) proposes A+ transfusion.");
  console.log("  Shared residual has blood_type=A+ in rejected. Hard block.");

  const t7 = agentStep("diagnostics", state, residual, {
    input: {},
    proposals: [
      // Wrong-type transfusion — catastrophic if it fired
      { kind: "action", type: "CROSSMATCH_BLOOD_A+", dependsOn: ["blood_type=A+"] },
      // Safe imaging alternative proceeds
      { kind: "action", type: "INTERPRET_MRA_RESULTS", dependsOn: [] },
    ],
  });
  state = t7.result.stateNext;
  residual = t7.result.residualNext;
  printStep("A+ cross-match BLOCKED (permanently foreclosed) — ABO mismatch prevented", t7);

  // ── TICK 8: Final renal evidence arrives — contrast CT now cleared ─────────
  console.log("\n━━━ TICK 8: Repeat creatinine — eGFR 74, evidence now 0.85 ━━━━━━━");
  console.log("  Renal function cleared. Contrast CT angiogram can now proceed.");
  console.log("  Dissection grade will determine surgical approach.");

  const t8 = agentStep("diagnostics", state, residual, {
    input: {
      evidence: { kidney_function_ok: 0.85 },
    },
    proposals: [
      { kind: "action", type: "ORDER_CT_ANGIOGRAM_CONTRAST", dependsOn: ["kidney_function_ok"] },
    ],
  });
  state = t8.result.stateNext;
  residual = t8.result.residualNext;
  printStep("contrast CT approved — all residual cleared, surgical plan can proceed", t8);

  // ── Final residual audit ───────────────────────────────────────────────────
  console.log("\n━━━ FINAL RESIDUAL AUDIT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  tensions    : ${residual.tensions.length === 0 ? "✓ none" : residual.tensions.map((t) => `${t.phi1}⟷${t.phi2}`)}`);
  console.log(`  evidenceGaps: ${residual.evidenceGaps.length === 0 ? "✓ none" : residual.evidenceGaps.map((g) => g.phi)}`);
  console.log(`  deferred    : ${residual.deferred.length === 0 ? "✓ none" : residual.deferred.length}`);
  console.log(`  rejected    : ${state.rejected.join(", ")}`);
  console.log("\n  Patient stable. Residual clear. Operative plan locked.");
  console.log("  ABO mismatch prevented. Wrong anticoag prevented. Runtime held.");
}

runIcuTriageScenario();
