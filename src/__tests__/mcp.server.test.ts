import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createResidualMcpServer } from "../mcp/server";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "residual-mcp-server-"));
}

function readStructuredContent<T>(result: unknown): T {
  const payload = result as { structuredContent?: T };
  if (payload.structuredContent === undefined) {
    throw new Error("Tool call did not return structuredContent");
  }
  return payload.structuredContent;
}

async function expectToolCallError(
  call: () => Promise<unknown>,
  pattern: RegExp
): Promise<void> {
  try {
    const result = await call();
    const payload = result as {
      isError?: boolean;
      content?: Array<{ text?: string }>;
    };
    if (payload.isError === true) {
      const text =
        payload.content?.map((item) => item.text ?? "").join("\n") ?? "";
      assert.match(text, pattern);
      return;
    }
    assert.fail("Expected tool call to fail");
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    assert.match(message, pattern);
  }
}

test("MCP server exposes expected tools and supports basic step flow", async () => {
  const dir = makeTmpDir();

  const { server } = createResidualMcpServer({ sessionRootDir: dir });
  const client = new Client({ name: "residual-runtime-test-client", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const listedTools = await client.listTools();
    const names = listedTools.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      "export_assurance_bundle",
      "get_state",
      "list_sessions",
      "new_session",
      "step",
      "suggest_repairs",
      "update_session",
    ]);

    const newSessionResult = await client.callTool({
      name: "new_session",
      arguments: {
        sessionId: "room-a",
        metadata: {
          objectiveType: "ticket",
          objectiveRef: "ABC-42",
          title: "Stabilize deploy gate",
        },
      },
    });
    const newSession = readStructuredContent<{
      sessionId: string;
      stepCount: number;
      sessionPath: string;
      metadata: { objectiveType?: string; objectiveRef?: string; status: string };
    }>(newSessionResult);
    assert.equal(newSession.sessionId, "room-a");
    assert.equal(newSession.stepCount, 0);
    assert.equal(newSession.sessionPath.endsWith("sessions.sqlite"), true);
    assert.equal(newSession.metadata.objectiveType, "ticket");
    assert.equal(newSession.metadata.objectiveRef, "ABC-42");
    assert.equal(newSession.metadata.status, "active");

    const blockedStepResult = await client.callTool({
      name: "step",
      arguments: {
        sessionId: "room-a",
        context: { branch: "feature/abc-42", commitSha: "deadbeef", actorId: "agent-1" },
        input: { constraints: [{ type: "Unresolved", phi1: "x=true", phi2: "x=false" }] },
        proposals: [{ kind: "action", type: "USE_X_TRUE", dependsOn: ["x=true"] }],
      },
    });

    const blockedStep = readStructuredContent<{
      stepCount: number;
      metadata: { objectiveRef?: string };
      lastEventContext?: { branch?: string; actorId?: string };
      replayAttestation?: {
        runtimeVersion: string;
        schemaVersion: string;
        policyVersion: string;
      };
      actionsApproved: Array<{ type: string }>;
      blocked: Array<{
        action: { type: string };
        certificates: Array<{
          blockerType: string;
          atoms: string[];
          ownership: {
            ownerRole: string;
            ownerRef: string;
            sla: { targetMs: number; escalationTarget: string };
          };
          recommendations: { semantics: string; moves: Array<{ kind: string; target: string }> };
          next: { kind: string };
        }>;
      }>;
      residualSummary: {
        counts: { assumptions: number; deferred: number; tensions: number; evidenceGaps: number };
        hasOpenBlockers: boolean;
      };
    }>(blockedStepResult);

    assert.equal(blockedStep.stepCount, 1);
    assert.equal(blockedStep.actionsApproved.length, 0);
    assert.equal(blockedStep.blocked.length, 1);
    assert.equal(blockedStep.blocked[0].action.type, "USE_X_TRUE");
    assert.ok(blockedStep.blocked[0].certificates.length >= 1);
    assert.ok(
      blockedStep.blocked[0].certificates.some(
        (certificate) =>
          certificate.blockerType === "epistemic_tension" &&
          certificate.ownership.ownerRole === "arbiter" &&
          certificate.ownership.sla.targetMs > 0 &&
          certificate.recommendations.semantics === "advisory" &&
          certificate.recommendations.moves.some((move) => move.kind === "query") &&
          certificate.next.kind === "adjudicate_tension"
      )
    );
    assert.equal(blockedStep.residualSummary.counts.tensions, 1);
    assert.equal(blockedStep.residualSummary.hasOpenBlockers, true);
    assert.equal("tensions" in blockedStep.residualSummary, false);
    assert.equal("repairPlan" in (blockedStep as Record<string, unknown>), false);
    assert.equal(blockedStep.metadata.objectiveRef, "ABC-42");
    assert.equal(blockedStep.lastEventContext?.branch, "feature/abc-42");
    assert.equal(blockedStep.lastEventContext?.actorId, "agent-1");
    assert.equal(blockedStep.replayAttestation?.schemaVersion, "replay.v2");

    const approvedStepResult = await client.callTool({
      name: "step",
      arguments: {
        sessionId: "room-a",
        input: { adjudications: [{ phi1: "x=true", phi2: "x=false", winner: "x=true" }] },
        proposals: [{ kind: "action", type: "USE_X_TRUE", dependsOn: ["x=true"] }],
      },
    });

    const approvedStep = readStructuredContent<{
      stepCount: number;
      actionsApproved: Array<{ type: string }>;
      blocked: Array<{ action: { type: string } }>;
    }>(approvedStepResult);

    assert.equal(approvedStep.stepCount, 2);
    assert.equal(approvedStep.actionsApproved.length, 1);
    assert.equal(approvedStep.actionsApproved[0].type, "USE_X_TRUE");
    assert.equal(approvedStep.blocked.length, 0);

    const stateResult = await client.callTool({
      name: "get_state",
      arguments: { sessionId: "room-a" },
    });
    const state = readStructuredContent<{
      stepCount: number;
      metadata: { objectiveRef?: string };
      lastEventContext?: { branch?: string; actorId?: string };
      lastReplayAttestation?: {
        runtimeVersion: string;
        schemaVersion: string;
        policyVersion: string;
      };
      residualSummary: {
        counts: { tensions: number };
        tensions: unknown[];
      };
    }>(stateResult);
    assert.equal(state.stepCount, 2);
    assert.equal(state.metadata.objectiveRef, "ABC-42");
    assert.equal(state.lastEventContext?.branch, "feature/abc-42");
    assert.equal(state.lastReplayAttestation?.runtimeVersion, "0.1.0");
    assert.equal(state.residualSummary.counts.tensions, 0);
    assert.ok(Array.isArray(state.residualSummary.tensions));

    const listedSessionsResult = await client.callTool({
      name: "list_sessions",
      arguments: {},
    });
    const listedSessions = readStructuredContent<{
      sessions: Array<{ sessionId: string; stepCount: number; metadata: { objectiveRef?: string; status: string } }>;
    }>(
      listedSessionsResult
    );
    assert.equal(listedSessions.sessions.length, 1);
    assert.equal(listedSessions.sessions[0].sessionId, "room-a");
    assert.equal(listedSessions.sessions[0].stepCount, 2);
    assert.equal(listedSessions.sessions[0].metadata.objectiveRef, "ABC-42");
    assert.equal(listedSessions.sessions[0].metadata.status, "active");
  } finally {
    await client.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP export_assurance_bundle returns deterministic assurance artifact", async () => {
  const dir = makeTmpDir();
  const { server } = createResidualMcpServer({ sessionRootDir: dir });
  const client = new Client({ name: "residual-runtime-test-client", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    await client.callTool({ name: "new_session", arguments: { sessionId: "bundle-room" } });
    await client.callTool({
      name: "step",
      arguments: {
        sessionId: "bundle-room",
        input: { constraints: [{ type: "Unresolved", phi1: "x=true", phi2: "x=false" }] },
        proposals: [{ kind: "action", type: "USE_X_TRUE", dependsOn: ["x=true"] }],
      },
    });

    const exported = readStructuredContent<{
      sessionId: string;
      stepCount: number;
      bundle: {
        bundleVersion: string;
        metrics: { totalSteps: number };
        decision: { combinedDecisionHash: string; decisionHashes: string[] };
        attestation: { withAttestation: number };
        ccp: { valid: boolean };
      };
      replayEvents?: unknown[];
    }>(
      await client.callTool({
        name: "export_assurance_bundle",
        arguments: { sessionId: "bundle-room", includeReplayEvents: true },
      })
    );

    assert.equal(exported.sessionId, "bundle-room");
    assert.equal(exported.stepCount, 1);
    assert.equal(exported.bundle.bundleVersion, "assurance.v1");
    assert.equal(exported.bundle.metrics.totalSteps, 1);
    assert.equal(exported.bundle.attestation.withAttestation, 1);
    assert.equal(exported.bundle.decision.decisionHashes.length, 1);
    assert.ok(exported.bundle.decision.combinedDecisionHash.length > 0);
    assert.equal(exported.bundle.ccp.valid, true);
    assert.equal(Array.isArray(exported.replayEvents), true);
  } finally {
    await client.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP suggest_repairs compiles blocked certificates without mutating session state", async () => {
  const dir = makeTmpDir();

  const { server } = createResidualMcpServer({ sessionRootDir: dir });
  const client = new Client({
    name: "residual-runtime-test-client",
    version: "0.1.0",
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    await client.callTool({
      name: "new_session",
      arguments: { sessionId: "room-a" },
    });

    const blockedStep = readStructuredContent<{
      blocked: Array<{
        action: { kind: "action"; type: string };
        certificates: Array<{ blockerType: string; next: { kind: string } }>;
      }>;
    }>(
      await client.callTool({
        name: "step",
        arguments: {
          sessionId: "room-a",
          input: { constraints: [{ type: "Unresolved", phi1: "x=true", phi2: "x=false" }] },
          proposals: [{ kind: "action", type: "USE_X_TRUE", dependsOn: ["x=true"] }],
        },
      })
    );
    assert.equal(blockedStep.blocked.length, 1);

    const before = readStructuredContent<{ stepCount: number }>(
      await client.callTool({
        name: "get_state",
        arguments: { sessionId: "room-a" },
      })
    );

    const suggested = readStructuredContent<{
      action: { kind: "action"; type: string };
      repairPlan: {
        intents: Array<{ strict: { kind: string } }>;
        summary: { requiresReplan: boolean; actionableIntents: number };
      };
      surface: string;
      rationale: string;
    }>(
      await client.callTool({
        name: "suggest_repairs",
        arguments: { blocked: blockedStep.blocked[0] },
      })
    );

    assert.equal(suggested.surface, "suggest_repairs");
    assert.equal(suggested.action.kind, "action");
    assert.equal(suggested.action.type, "USE_X_TRUE");
    assert.ok(suggested.rationale.length > 0);
    assert.ok(suggested.repairPlan.intents.length >= 1);
    assert.ok(
      suggested.repairPlan.intents.some(
        (intent) => intent.strict.kind === "adjudicate_tension"
      )
    );
    assert.equal(suggested.repairPlan.summary.actionableIntents >= 1, true);
    assert.equal(suggested.repairPlan.summary.requiresReplan, false);

    const after = readStructuredContent<{ stepCount: number }>(
      await client.callTool({
        name: "get_state",
        arguments: { sessionId: "room-a" },
      })
    );
    assert.equal(after.stepCount, before.stepCount);
  } finally {
    await client.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP update_session releases durable resource claims and can close a session", async () => {
  const dir = makeTmpDir();

  const { server } = createResidualMcpServer({ sessionRootDir: dir });
  const client = new Client({ name: "residual-runtime-test-client", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    await client.callTool({ name: "new_session", arguments: { sessionId: "room-a" } });
    await client.callTool({ name: "new_session", arguments: { sessionId: "room-b" } });

    await client.callTool({
      name: "step",
      arguments: {
        sessionId: "room-a",
        context: { branch: "feature/shared", worktreeId: "wt-shared" },
        proposals: [{ kind: "action", type: "WRITE_X", writeSet: ["resource:x"] }],
      },
    });

    await client.callTool({
      name: "step",
      arguments: {
        sessionId: "room-a",
        context: { branch: "feature/shared", worktreeId: "wt-shared" },
        proposals: [{ kind: "action", type: "WRITE_Y", writeSet: ["resource:y"] }],
      },
    });

    const blocked = readStructuredContent<{
      actionsApproved: Array<{ type: string }>;
      blocked: Array<{ action: { type: string } }>;
    }>(
      await client.callTool({
        name: "step",
        arguments: {
          sessionId: "room-b",
          context: { branch: "feature/shared", worktreeId: "wt-shared" },
          proposals: [{ kind: "action", type: "WRITE_X_2", writeSet: ["resource:x"] }],
        },
      })
    );
    assert.equal(blocked.actionsApproved.length, 0);
    assert.equal(blocked.blocked.length, 1);

    const released = readStructuredContent<{
      metadata: { status: string };
      heldResourceClaims: Array<{ type: string }>;
    }>(
      await client.callTool({
        name: "update_session",
        arguments: {
          sessionId: "room-a",
          releaseResourceClaims: true,
          metadata: { status: "closed" },
        },
      })
    );
    assert.equal(released.metadata.status, "closed");
    assert.equal(released.heldResourceClaims.length, 0);

    const unblocked = readStructuredContent<{
      actionsApproved: Array<{ type: string }>;
      blocked: Array<{ action: { type: string } }>;
    }>(
      await client.callTool({
        name: "step",
        arguments: {
          sessionId: "room-b",
          context: { branch: "feature/shared", worktreeId: "wt-shared" },
          proposals: [{ kind: "action", type: "WRITE_X_AFTER_RELEASE", writeSet: ["resource:x"] }],
        },
      })
    );
    assert.equal(unblocked.actionsApproved.length, 1);
    assert.equal(unblocked.blocked.length, 0);
  } finally {
    await client.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP step surfaces cross-session conflicts with unblock guidance", async () => {
  const dir = makeTmpDir();

  const { server } = createResidualMcpServer({ sessionRootDir: dir });
  const client = new Client({ name: "residual-runtime-test-client", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    await client.callTool({
      name: "new_session",
      arguments: { sessionId: "room-a" },
    });
    await client.callTool({
      name: "new_session",
      arguments: { sessionId: "room-b" },
    });

    await client.callTool({
      name: "step",
      arguments: {
        sessionId: "room-a",
        context: { branch: "feature/shared" },
        proposals: [{ kind: "action", type: "WRITE_X", writeSet: ["resource:x"] }],
      },
    });

    const conflictingStepResult = await client.callTool({
      name: "step",
      arguments: {
        sessionId: "room-b",
        context: { branch: "feature/shared" },
        proposals: [{ kind: "action", type: "READ_X", readSet: ["resource:x"] }],
      },
    });

    const conflictingStep = readStructuredContent<{
      actionsApproved: Array<{ type: string }>;
      blocked: Array<{
        action: { type: string };
        certificates: Array<{
          blockerType: string;
          atoms: string[];
          recommendations: { semantics: string; moves: Array<{ kind: string; target: string }> };
          next: { kind: string; conflictType?: string; resource?: string; otherSessionId?: string };
        }>;
      }>;
      events: {
        sessionArbitrationPolicy: { enabled: boolean; defaultMode: string };
        riskEscalations: Array<{ tier: string; reason: string; requiredHumanReview: boolean }>;
        sessionConflicts: Array<{
          conflictType: string;
          resource: string;
          otherSessionId: string;
          unblock: unknown[];
        }>;
        sessionArbitrations: Array<{
          mode: string;
          outcome: string;
          resource: string;
          otherSessionId: string;
          unblock: unknown[];
        }>;
      };
    }>(conflictingStepResult);

    assert.equal(conflictingStep.actionsApproved.length, 0);
    assert.equal(conflictingStep.blocked.length, 1);
    assert.equal(conflictingStep.blocked[0].action.type, "READ_X");
    assert.ok(
      conflictingStep.blocked[0].certificates.some(
        (certificate) =>
          certificate.blockerType === "session_coordination" &&
          certificate.recommendations.semantics === "advisory" &&
          certificate.recommendations.moves.some(
            (move) => move.kind === "query" || move.kind === "observe"
          ) &&
          certificate.next.kind === "coordinate_session" &&
          certificate.next.conflictType === "read_write" &&
          certificate.next.resource === "resource:x" &&
          certificate.next.otherSessionId === "room-a"
      ),
      "blocked action should carry a typed session coordination certificate"
    );
    assert.equal(conflictingStep.events.sessionConflicts.length, 1);
    assert.equal(conflictingStep.events.sessionArbitrationPolicy.enabled, true);
    assert.equal(conflictingStep.events.sessionArbitrationPolicy.defaultMode, "serialize_first");
    assert.equal(conflictingStep.events.sessionArbitrations.length, 1);
    assert.equal(conflictingStep.events.riskEscalations.length, 0);
    assert.equal(conflictingStep.events.sessionArbitrations[0].mode, "serialize_first");
    assert.equal(conflictingStep.events.sessionArbitrations[0].outcome, "serialize_wait");
    assert.equal(conflictingStep.events.sessionConflicts[0].conflictType, "read_write");
    assert.equal(conflictingStep.events.sessionConflicts[0].resource, "resource:x");
    assert.equal(conflictingStep.events.sessionConflicts[0].otherSessionId, "room-a");
    assert.ok(conflictingStep.events.sessionConflicts[0].unblock.length >= 1);
    assert.ok(conflictingStep.events.sessionArbitrations[0].unblock.length >= 1);

    const suggested = readStructuredContent<{
      repairPlan: {
        intents: Array<{
          strict: {
            kind: string;
            conflictType?: string;
            resource?: string;
            otherSessionId?: string;
            mode?: string;
            outcome?: string;
            unblock?: Array<{ kind: string; detail: string }>;
          };
        }>;
      };
    }>(
      await client.callTool({
        name: "suggest_repairs",
        arguments: { blocked: conflictingStep.blocked[0] },
      })
    );
    const coordinationIntent = suggested.repairPlan.intents.find(
      (intent) => intent.strict.kind === "coordinate_session"
    );
    assert.ok(coordinationIntent, "expected coordinate_session repair intent");
    assert.equal(coordinationIntent?.strict.conflictType, "read_write");
    assert.equal(coordinationIntent?.strict.resource, "resource:x");
    assert.equal(coordinationIntent?.strict.otherSessionId, "room-a");
    assert.equal(coordinationIntent?.strict.mode, "serialize_first");
    assert.equal(coordinationIntent?.strict.outcome, "serialize_wait");
    assert.ok((coordinationIntent?.strict.unblock?.length ?? 0) >= 1);
  } finally {
    await client.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP step emits risk escalation events for blocked high-risk actions", async () => {
  const dir = makeTmpDir();
  const { server } = createResidualMcpServer({ sessionRootDir: dir });
  const client = new Client({ name: "residual-runtime-test-client", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    await client.callTool({ name: "new_session", arguments: { sessionId: "risk-room" } });

    const result = readStructuredContent<{
      actionsApproved: Array<{ type: string }>;
      blocked: Array<{ action: { type: string } }>;
      events: {
        riskEscalations: Array<{
          tier: string;
          reason: string;
          requiredHumanReview: boolean;
          action: { type: string };
        }>;
      };
    }>(
      await client.callTool({
        name: "step",
        arguments: {
          sessionId: "risk-room",
          input: {
            constraints: [{ type: "RequireEvidence", phi: "security_scan_ok", threshold: 0.95 }],
            evidence: { security_scan_ok: 0.4 },
          },
          proposals: [
            {
              kind: "action",
              type: "DEPLOY_TO_PRODUCTION",
              riskTier: "critical",
              dependsOn: ["security_scan_ok"],
            },
          ],
        },
      })
    );

    assert.equal(result.actionsApproved.length, 0);
    assert.equal(result.blocked.length, 1);
    assert.equal(result.events.riskEscalations.length, 1);
    assert.equal(result.events.riskEscalations[0].tier, "critical");
    assert.equal(result.events.riskEscalations[0].reason, "blocked_high_risk_action");
    assert.equal(result.events.riskEscalations[0].requiredHumanReview, true);
    assert.equal(result.events.riskEscalations[0].action.type, "DEPLOY_TO_PRODUCTION");
  } finally {
    await client.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP step enforces operationId idempotency contract", async () => {
  const dir = makeTmpDir();
  const { server } = createResidualMcpServer({ sessionRootDir: dir });
  const client = new Client({ name: "residual-runtime-test-client", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    await client.callTool({ name: "new_session", arguments: { sessionId: "idempotency-room" } });

    const first = readStructuredContent<{ actionsApproved: Array<{ type: string }> }>(
      await client.callTool({
        name: "step",
        arguments: {
          sessionId: "idempotency-room",
          proposals: [{ kind: "action", type: "DEPLOY", operationId: "op-9" }],
        },
      })
    );
    assert.equal(first.actionsApproved.length, 1);

    const duplicate = readStructuredContent<{
      actionsApproved: Array<{ type: string }>;
      blocked: Array<{ action: { type: string } }>;
      events: { idempotencyEvents: Array<{ operationId: string; outcome: string }> };
    }>(
      await client.callTool({
        name: "step",
        arguments: {
          sessionId: "idempotency-room",
          proposals: [{ kind: "action", type: "DEPLOY", operationId: "op-9" }],
        },
      })
    );
    assert.equal(duplicate.actionsApproved.length, 0);
    assert.equal(duplicate.blocked.length, 0);
    assert.equal(duplicate.events.idempotencyEvents.length, 1);
    assert.equal(duplicate.events.idempotencyEvents[0].operationId, "op-9");
    assert.equal(duplicate.events.idempotencyEvents[0].outcome, "duplicate_approved_ignored");

    const conflict = readStructuredContent<{
      actionsApproved: Array<{ type: string }>;
      blocked: Array<{ action: { type: string } }>;
      events: { idempotencyEvents: Array<{ operationId: string; outcome: string }> };
    }>(
      await client.callTool({
        name: "step",
        arguments: {
          sessionId: "idempotency-room",
          proposals: [{ kind: "action", type: "DEPLOY", operationId: "op-9", revocable: true }],
        },
      })
    );
    assert.equal(conflict.actionsApproved.length, 0);
    assert.equal(conflict.blocked.length, 1);
    assert.equal(conflict.events.idempotencyEvents.length, 1);
    assert.equal(conflict.events.idempotencyEvents[0].operationId, "op-9");
    assert.equal(conflict.events.idempotencyEvents[0].outcome, "operation_conflict_blocked");
  } finally {
    await client.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP server rejects malformed tool arguments deterministically", async () => {
  const dir = makeTmpDir();

  const { server } = createResidualMcpServer({ sessionRootDir: dir });
  const client = new Client({
    name: "residual-runtime-test-client",
    version: "0.1.0",
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    await expectToolCallError(
      () =>
        client.callTool({
          name: "step",
          arguments: {
            sessionId: "   ",
          },
        }),
      /sessionid|min/i
    );

    await expectToolCallError(
      () =>
        client.callTool({
          name: "new_session",
          arguments: {
            sessionId: "bad-seed",
            seedInput: null,
          },
        }),
      /seedinput|object/i
    );

    await expectToolCallError(
      () =>
        client.callTool({
          name: "step",
          arguments: {
            sessionId: "room-a",
            proposals: [{ kind: "unknown_kind", type: "X" }],
          },
        }),
      /invalid discriminator|kind/i
    );

    await expectToolCallError(
      () =>
        client.callTool({
          name: "new_session",
          arguments: {
            sessionId: "bad-metadata",
            metadata: {
              status: "active",
              closedAt: 100,
            },
          },
        }),
      /closedat|active/i
    );

    await client.callTool({
      name: "new_session",
      arguments: { sessionId: "room-a" },
    });

    await expectToolCallError(
      () =>
        client.callTool({
          name: "step",
          arguments: {
            sessionId: "room-a",
            proposals: [{ kind: "action", type: "WRITE_X", writeSet: ["resource:x"] }],
          },
        }),
      /branch or worktree context/i
    );

    await expectToolCallError(
      () =>
        client.callTool({
          name: "suggest_repairs",
          arguments: {
            blocked: {
              action: { kind: "action", type: "WRITE_X" },
              certificates: [],
            },
          },
        }),
      /certificates|min|at least/i
    );
  } finally {
    await client.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
