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
    assert.deepEqual(names, ["get_state", "list_sessions", "new_session", "step"]);

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
      actionsApproved: Array<{ type: string }>;
      actionsBlocked: Array<{ type: string }>;
      whatWouldUnblock: Array<{ analysis: { permanent: boolean; deltas: unknown[] } }>;
    }>(blockedStepResult);

    assert.equal(blockedStep.stepCount, 1);
    assert.equal(blockedStep.actionsApproved.length, 0);
    assert.equal(blockedStep.actionsBlocked.length, 1);
    assert.equal(blockedStep.whatWouldUnblock.length, 1);
    assert.equal(blockedStep.whatWouldUnblock[0].analysis.permanent, false);
    assert.ok(blockedStep.whatWouldUnblock[0].analysis.deltas.length >= 1);
    assert.equal(blockedStep.metadata.objectiveRef, "ABC-42");
    assert.equal(blockedStep.lastEventContext?.branch, "feature/abc-42");
    assert.equal(blockedStep.lastEventContext?.actorId, "agent-1");

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
      actionsBlocked: Array<{ type: string }>;
    }>(approvedStepResult);

    assert.equal(approvedStep.stepCount, 2);
    assert.equal(approvedStep.actionsApproved.length, 1);
    assert.equal(approvedStep.actionsApproved[0].type, "USE_X_TRUE");
    assert.equal(approvedStep.actionsBlocked.length, 0);

    const stateResult = await client.callTool({
      name: "get_state",
      arguments: { sessionId: "room-a" },
    });
    const state = readStructuredContent<{
      stepCount: number;
      metadata: { objectiveRef?: string };
      lastEventContext?: { branch?: string; actorId?: string };
    }>(stateResult);
    assert.equal(state.stepCount, 2);
    assert.equal(state.metadata.objectiveRef, "ABC-42");
    assert.equal(state.lastEventContext?.branch, "feature/abc-42");

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
      actionsBlocked: Array<{ type: string }>;
      whatWouldUnblock: Array<{
        sessionConflicts: Array<{ conflictType: string; resource: string; otherSessionId: string; unblock: unknown[] }>;
        sessionArbitrations: Array<{ mode: string; outcome: string; resource: string; otherSessionId: string; unblock: unknown[] }>;
      }>;
      events: {
        sessionArbitrationPolicy: { enabled: boolean; defaultMode: string };
        sessionConflicts: Array<{ conflictType: string; resource: string; otherSessionId: string }>;
        sessionArbitrations: Array<{ mode: string; outcome: string; resource: string; otherSessionId: string }>;
      };
    }>(conflictingStepResult);

    assert.equal(conflictingStep.actionsApproved.length, 0);
    assert.equal(conflictingStep.actionsBlocked.length, 1);
    assert.equal(conflictingStep.events.sessionConflicts.length, 1);
    assert.equal(conflictingStep.events.sessionArbitrationPolicy.enabled, true);
    assert.equal(conflictingStep.events.sessionArbitrationPolicy.defaultMode, "serialize_first");
    assert.equal(conflictingStep.events.sessionArbitrations.length, 1);
    assert.equal(conflictingStep.events.sessionArbitrations[0].mode, "serialize_first");
    assert.equal(conflictingStep.events.sessionArbitrations[0].outcome, "serialize_wait");
    assert.equal(conflictingStep.events.sessionConflicts[0].conflictType, "read_write");
    assert.equal(conflictingStep.events.sessionConflicts[0].resource, "resource:x");
    assert.equal(conflictingStep.events.sessionConflicts[0].otherSessionId, "room-a");
    assert.equal(conflictingStep.whatWouldUnblock.length, 1);
    assert.equal(conflictingStep.whatWouldUnblock[0].sessionConflicts.length, 1);
    assert.equal(conflictingStep.whatWouldUnblock[0].sessionArbitrations.length, 1);
    assert.ok(conflictingStep.whatWouldUnblock[0].sessionConflicts[0].unblock.length >= 1);
    assert.ok(conflictingStep.whatWouldUnblock[0].sessionArbitrations[0].unblock.length >= 1);
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
  } finally {
    await client.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
