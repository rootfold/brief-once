import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { NodeFileSystem } from "../../src/core/filesystem/node-filesystem.js";
import { createAgentFoldService } from "../../src/integrations/service/create-service.js";
import {
  connectToAgentFoldService,
  type AgentFoldServiceClient,
} from "../../src/integrations/service/service-client.js";
import { AgentFoldServiceCoordinator } from "../../src/integrations/service/service-coordinator.js";
import { createServiceEndpoint } from "../../src/integrations/service/service-endpoint.js";
import { agentFoldServiceProtocolVersion } from "../../src/integrations/service/service-protocol.js";
import {
  removeServiceRuntimeMetadata,
  writeServiceRuntimeMetadata,
} from "../../src/integrations/service/runtime-metadata.js";
import { prepareServiceRuntimeDirectory } from "../../src/integrations/service/runtime-directory.js";
import { createContinuityFixture, StubGitInspector } from "../helpers/continuity-fixture.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function rawRequest(endpoint: string, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = net.createConnection(endpoint);
    socket.on("connect", () => socket.write(payload));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.on("error", reject);
  });
}

describe("AgentFold local IPC", () => {
  it("authenticates one-request connections and returns safe service status", async () => {
    const fixture = await createContinuityFixture(temporaryDirectories, {
      name: "agentfold-ipc-repo-",
    });
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "agentfold-ipc-runtime-"));
    temporaryDirectories.push(runtimeRoot);
    const fileSystem = new NodeFileSystem();
    const runtime = await prepareServiceRuntimeDirectory({
      fileSystem,
      runtimeDirectory: runtimeRoot,
      restrictDirectory: () => Promise.resolve(),
    });
    const endpoint = createServiceEndpoint(runtime.realDirectory, runtime.endpointKind);
    const token = Buffer.alloc(32, 7).toString("base64url");
    const coordinator = new AgentFoldServiceCoordinator({
      version: "0.0.0-test",
      startedAt: "2026-07-21T01:00:00.000Z",
      processId: 4321,
      endpointKind: runtime.endpointKind,
      fileSystem: fixture.fileSystem,
      gitRepositoryLocator: fixture.gitRepositoryLocator,
      gitInspector: new StubGitInspector(undefined, true),
    });
    const service = createAgentFoldService({ endpoint, token, coordinator });
    await service.start();
    await writeServiceRuntimeMetadata(
      fileSystem,
      runtime.realDirectory,
      {
        schemaVersion: 1,
        protocolVersion: agentFoldServiceProtocolVersion,
        serviceVersion: "0.0.0-test",
        pid: 4321,
        startedAt: "2026-07-21T01:00:00.000Z",
        endpointKind: runtime.endpointKind,
        endpoint,
        token,
      },
      () => Promise.resolve(),
    );

    const connected = await connectToAgentFoldService({
      fileSystem,
      clientVersion: "0.0.0-test",
      runtimeDirectory: runtime.realDirectory,
    });
    expect(connected.connected).toBe(true);
    const client = connected.connected
      ? connected.client
      : (undefined as never as AgentFoldServiceClient);
    const status = await client.status();
    expect(status).toMatchObject({
      running: true,
      processId: 4321,
      registeredRepositoryCount: 0,
      openSessionCount: 0,
      interruptedSessionCount: 0,
      recoveryPendingSessionCount: 0,
      recentRecoveryFailureCount: 0,
      reliabilityPersistenceEnabled: false,
    });
    expect(JSON.stringify(status)).not.toContain(token);
    expect(JSON.stringify(status)).not.toContain(fixture.root);

    const invalidToken = JSON.parse(
      await rawRequest(
        endpoint,
        `${JSON.stringify({
          id: "bad-token",
          token: "x".repeat(43),
          method: "service.ping",
          params: {},
          protocolVersion: 1,
        })}\n`,
      ),
    ) as { ok: boolean; error: { code: string } };
    expect(invalidToken).toMatchObject({ ok: false, error: { code: "AFSV009" } });

    const invalidJson = JSON.parse(await rawRequest(endpoint, "{not-json\n")) as {
      ok: boolean;
      error: { code: string };
    };
    expect(invalidJson.error.code).toBe("AFSV011");

    const missingToken = JSON.parse(
      await rawRequest(
        endpoint,
        `${JSON.stringify({ id: "missing", method: "service.ping", params: {}, protocolVersion: 1 })}\n`,
      ),
    ) as { error: { code: string } };
    expect(missingToken.error.code).toBe("AFSV009");

    const unsupportedProtocol = JSON.parse(
      await rawRequest(
        endpoint,
        `${JSON.stringify({
          id: "protocol",
          token,
          method: "service.ping",
          params: {},
          protocolVersion: 2,
        })}\n`,
      ),
    ) as { error: { code: string } };
    expect(unsupportedProtocol.error.code).toBe("AFSV012");

    const unknownMethod = JSON.parse(
      await rawRequest(
        endpoint,
        `${JSON.stringify({
          id: "unknown",
          token,
          method: "filesystem.read",
          params: {},
          protocolVersion: 1,
        })}\n`,
      ),
    ) as { ok: boolean; error: { code: string } };
    expect(unknownMethod.error.code).toBe("AFSV012");
    const oversized = JSON.parse(await rawRequest(endpoint, "x".repeat(1024 * 1024 + 1))) as {
      error: { code: string };
    };
    expect(oversized.error.code).toBe("AFSV010");
    await expect(client.ping()).resolves.toMatchObject({ status: "ready" });

    await service.stop();
    await removeServiceRuntimeMetadata(fileSystem, runtime.realDirectory);
    if (runtime.endpointKind === "unix-socket") await fileSystem.remove(endpoint);
  });
});
