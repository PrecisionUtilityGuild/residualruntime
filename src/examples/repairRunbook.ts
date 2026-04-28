import {
  DEPLOY_TO_PRODUCTION_ACTION,
  createDeployRepairSeed,
} from "./deployRepairFixtures";
import {
  createSeededFakeRepairAdapter,
  runRepairCycle,
} from "../runtime/repair";

export function runRepairRunbookProof() {
  const seeded = createDeployRepairSeed();
  const adapter = createSeededFakeRepairAdapter({
    adapterId: "repair-runbook-adapter",
    seed: 1000,
    script: {
      request_approval: [
        {
          inputPatch: {
            constraints: [{ type: "Prop", phi: "lead_review=done" }],
          },
          note: "lead review signed off",
        },
      ],
      run_check: [
        {
          inputPatch: { evidence: { security_scan: 0.92 } },
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
          note: "tests conflict resolved",
        },
      ],
    },
  });

  return runRepairCycle({
    state: seeded.state,
    residual: seeded.residual,
    targetAction: DEPLOY_TO_PRODUCTION_ACTION,
    adapter,
    maxCycles: 4,
    initialContext: { branch: "main", actorId: "runbook-operator" },
  });
}

function printCycle(cycle: (ReturnType<typeof runRepairRunbookProof>)["cycles"][number]) {
  console.log(`\nCycle ${cycle.cycle}`);
  console.log(
    `  certificates: ${cycle.certificates.map((certificate) => certificate.blockerId).join(", ") || "(none)"}`
  );
  console.log(
    `  intents: ${cycle.plan.intents.map((intent) => `${intent.kind}:${intent.strict.kind}`).join(", ") || "(none)"}`
  );
  console.log(
    `  observations: ${cycle.observations.map((obs) => `${obs.provenance.source}:${obs.provenance.capability}:${obs.provenance.target}`).join(", ") || "(none)"}`
  );
  console.log(
    `  generatedInput keys: ${Object.keys(cycle.generatedInput).join(", ") || "(none)"}`
  );
  if (cycle.stepResult) {
    console.log(
      `  approved: ${cycle.stepResult.actionsApproved.map((action) => action.type).join(", ") || "(none)"}`
    );
    console.log(
      `  blocked: ${cycle.stepResult.actionsBlocked.map((action) => action.type).join(", ") || "(none)"}`
    );
  }
}

function main() {
  const result = runRepairRunbookProof();

  console.log("Deterministic Repair Runbook: DEPLOY_TO_PRODUCTION");
  console.log(`status: ${result.status}`);
  if (result.status === "failed") {
    console.log(`failure: ${result.failureCode ?? "unknown"} - ${result.failureMessage ?? "no message"}`);
  }

  for (const cycle of result.cycles) {
    printCycle(cycle);
  }

  console.log(
    `\nfinal approved: ${result.targetActionApproved ? "yes" : "no"}`
  );
  console.log(
    `final residual counts: tensions=${result.residual.tensions.length}, evidenceGaps=${result.residual.evidenceGaps.length}, deferred=${result.residual.deferred.length}`
  );
}

if (require.main === module) {
  main();
}
