import { randomUUID } from "node:crypto";
import net from "node:net";

import type { Diagnostic } from "../../core/diagnostics/diagnostic.js";
import type { FileSystem } from "../../core/filesystem/filesystem.js";
import { samePlatformPath } from "../../core/filesystem/platform-path-aliases.js";
import type { AgentFoldMcpResult } from "../mcp/mcp-response.js";
import type {
  BeginTaskInput,
  CloseSessionInput,
  CreateCheckpointInput,
  FinishTaskInput,
  GetContextInput,
  GetResumePacketInput,
  OpenSessionInput,
  ReportProgressInput,
} from "../mcp/tool-schemas.js";
import { createServiceEndpoint } from "./service-endpoint.js";
import {
  agentFoldServiceProtocolVersion,
  maximumServiceMessageBytes,
  serviceResponseSchema,
  type ServiceMethodName,
  type ServiceRequest,
  type ServiceResponse,
} from "./service-protocol.js";
import { readServiceRuntimeMetadata, type ServiceRuntimeMetadata } from "./runtime-metadata.js";
import {
  nodeServicePlatformInput,
  resolveServiceRuntimeLocation,
  type ServicePlatformInput,
} from "./runtime-directory.js";
import type { SafeAgentFoldServiceStatus } from "./service-types.js";

export interface AgentFoldServiceClient {
  ping(): Promise<ServicePing>;
  status(): Promise<SafeAgentFoldServiceStatus>;
  shutdown(): Promise<void>;
  openSession(workspace: string, input: OpenSessionInput): Promise<AgentFoldMcpResult>;
  heartbeat(sessionId: string): Promise<{ readonly leaseExpiresAt: string }>;
  detach(sessionId: string): Promise<void>;
  closeSession(input: CloseSessionInput): Promise<AgentFoldMcpResult>;
  getStatus(workspace: string): Promise<AgentFoldMcpResult>;
  getContext(workspace: string, input: GetContextInput): Promise<AgentFoldMcpResult>;
  beginTask(input: BeginTaskInput): Promise<AgentFoldMcpResult>;
  reportProgress(input: ReportProgressInput): Promise<AgentFoldMcpResult>;
  createCheckpoint(input: CreateCheckpointInput): Promise<AgentFoldMcpResult>;
  finishTask(input: FinishTaskInput): Promise<AgentFoldMcpResult>;
  getResumePacket(input: GetResumePacketInput): Promise<AgentFoldMcpResult>;
}

export interface ServicePing {
  readonly protocolVersion: typeof agentFoldServiceProtocolVersion;
  readonly serviceVersion: string;
  readonly status: "ready";
  readonly endpointKind: "named-pipe" | "unix-socket";
}

export interface ConnectServiceClientInput {
  readonly fileSystem: FileSystem;
  readonly clientVersion: string;
  readonly runtimeDirectory?: string;
  readonly platform?: ServicePlatformInput;
  readonly timeoutMilliseconds?: number;
  readonly generateRequestId?: () => string;
}

export type ConnectServiceClientResult =
  | {
      readonly status: "connected";
      readonly client: AgentFoldServiceClient;
      readonly metadata: ServiceRuntimeMetadata;
      readonly diagnostics: readonly Diagnostic[];
    }
  | {
      readonly status: "unavailable" | "incompatible";
      readonly diagnostics: readonly Diagnostic[];
    };

export interface ServiceAvailability {
  readonly available: boolean;
  readonly status?: SafeAgentFoldServiceStatus;
  readonly diagnostics: readonly Diagnostic[];
}

export class ServiceClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly diagnostics: readonly Diagnostic[] = [],
  ) {
    super(message);
    this.name = "ServiceClientError";
  }
}

function packageMajor(version: string): number | undefined {
  const match = /^(\d+)\./u.exec(version.trim());
  return match === null ? undefined : Number(match[1]);
}

class NodeAgentFoldServiceClient implements AgentFoldServiceClient {
  constructor(
    private readonly metadata: ServiceRuntimeMetadata,
    private readonly timeoutMilliseconds: number,
    private readonly generateRequestId: () => string,
  ) {}

  private request<Result>(method: ServiceMethodName, params: unknown): Promise<Result> {
    const request: ServiceRequest = {
      id: this.generateRequestId(),
      token: this.metadata.token,
      method,
      params,
      protocolVersion: agentFoldServiceProtocolVersion,
    };
    const payload = `${JSON.stringify(request)}\n`;
    if (Buffer.byteLength(payload, "utf8") > maximumServiceMessageBytes) {
      return Promise.reject(new ServiceClientError("AFSV010", "The service request is too large."));
    }

    return new Promise<Result>((resolve, reject) => {
      const socket = net.createConnection(this.metadata.endpoint);
      let settled = false;
      let size = 0;
      const chunks: Buffer[] = [];
      const fail = (error: ServiceClientError): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(error);
      };
      socket.setTimeout(this.timeoutMilliseconds, () =>
        fail(new ServiceClientError("AFSV013", "The local service request timed out.")),
      );
      socket.on("connect", () => socket.write(payload));
      socket.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maximumServiceMessageBytes) {
          fail(new ServiceClientError("AFSV010", "The service response was too large."));
          return;
        }
        chunks.push(chunk);
      });
      socket.on("error", () =>
        fail(new ServiceClientError("AFSV013", "The BriefOnce local service is unavailable.")),
      );
      socket.on("end", () => {
        if (settled) return;
        let response: ServiceResponse;
        try {
          response = serviceResponseSchema.parse(
            JSON.parse(Buffer.concat(chunks).toString("utf8")),
          ) as ServiceResponse;
        } catch {
          fail(new ServiceClientError("AFSV011", "The service returned an invalid response."));
          return;
        }
        if (response.protocolVersion !== agentFoldServiceProtocolVersion) {
          fail(new ServiceClientError("AFSV012", "The service protocol version is incompatible."));
          return;
        }
        if (response.id !== request.id) {
          fail(new ServiceClientError("AFSV011", "The service response identifier did not match."));
          return;
        }
        if (!response.ok) {
          fail(
            new ServiceClientError(
              response.error.code,
              response.error.message,
              response.error.diagnostics,
            ),
          );
          return;
        }
        settled = true;
        resolve(response.result as Result);
      });
    });
  }

  ping(): Promise<ServicePing> {
    return this.request("service.ping", {});
  }
  status(): Promise<SafeAgentFoldServiceStatus> {
    return this.request("service.status", {});
  }
  async shutdown(): Promise<void> {
    await this.request("service.shutdown", {});
  }
  openSession(workspace: string, input: OpenSessionInput): Promise<AgentFoldMcpResult> {
    return this.request("session.open", { workspace, ...input });
  }
  async heartbeat(sessionId: string): Promise<{ readonly leaseExpiresAt: string }> {
    return this.request("session.heartbeat", { sessionId });
  }
  async detach(sessionId: string): Promise<void> {
    await this.request("session.detach", { sessionId });
  }
  closeSession(input: CloseSessionInput): Promise<AgentFoldMcpResult> {
    return this.request("session.close", input);
  }
  getStatus(workspace: string): Promise<AgentFoldMcpResult> {
    return this.request("integration.get_status", { workspace });
  }
  getContext(workspace: string, input: GetContextInput): Promise<AgentFoldMcpResult> {
    return this.request("integration.get_context", { workspace, ...input });
  }
  beginTask(input: BeginTaskInput): Promise<AgentFoldMcpResult> {
    return this.request("integration.begin_task", input);
  }
  reportProgress(input: ReportProgressInput): Promise<AgentFoldMcpResult> {
    return this.request("integration.report_progress", input);
  }
  createCheckpoint(input: CreateCheckpointInput): Promise<AgentFoldMcpResult> {
    return this.request("integration.create_checkpoint", input);
  }
  finishTask(input: FinishTaskInput): Promise<AgentFoldMcpResult> {
    return this.request("integration.finish_task", input);
  }
  getResumePacket(input: GetResumePacketInput): Promise<AgentFoldMcpResult> {
    return this.request("integration.get_resume_packet", input);
  }
}

function diagnostic(
  code: string,
  severity: Diagnostic["severity"],
  message: string,
  suggestion?: string,
): Diagnostic {
  return { code, severity, message, ...(suggestion === undefined ? {} : { suggestion }) };
}

export async function connectAgentFoldServiceClient(
  input: ConnectServiceClientInput,
): Promise<ConnectServiceClientResult> {
  const platform = input.platform ?? nodeServicePlatformInput();
  let location;
  try {
    location = resolveServiceRuntimeLocation(platform, input.runtimeDirectory);
    if (!(await input.fileSystem.exists(location.directory))) {
      return {
        status: "unavailable",
        diagnostics: [diagnostic("AFSV004", "info", "The BriefOnce service is not running.")],
      };
    }
    const realDirectory = await input.fileSystem.realPath(location.directory);
    if (!samePlatformPath(realDirectory, location.directory, platform.platform)) {
      return {
        status: "incompatible",
        diagnostics: [
          diagnostic(
            "AFSV005",
            "error",
            "The BriefOnce runtime directory is an unsafe symbolic link.",
          ),
        ],
      };
    }
    if (createServiceEndpoint(realDirectory, location.endpointKind).length === 0) throw new Error();
    const metadata = await readServiceRuntimeMetadata(input.fileSystem, realDirectory);
    if (metadata === undefined) {
      return {
        status: "unavailable",
        diagnostics: [diagnostic("AFSV004", "info", "The BriefOnce service is not running.")],
      };
    }
    const expectedEndpoint = createServiceEndpoint(realDirectory, location.endpointKind);
    if (metadata.endpointKind !== location.endpointKind || metadata.endpoint !== expectedEndpoint) {
      return {
        status: "incompatible",
        diagnostics: [diagnostic("AFSV012", "error", "The service endpoint kind is incompatible.")],
      };
    }
    const client = new NodeAgentFoldServiceClient(
      metadata,
      input.timeoutMilliseconds ?? 2_000,
      input.generateRequestId ?? (() => randomUUID()),
    );
    const ping = await client.ping();
    if (
      ping.protocolVersion !== agentFoldServiceProtocolVersion ||
      ping.endpointKind !== location.endpointKind
    ) {
      return {
        status: "incompatible",
        diagnostics: [diagnostic("AFSV012", "error", "The service protocol is incompatible.")],
      };
    }
    const serviceMajor = packageMajor(ping.serviceVersion);
    const clientMajor = packageMajor(input.clientVersion);
    if (serviceMajor !== undefined && clientMajor !== undefined && serviceMajor !== clientMajor) {
      return {
        status: "incompatible",
        diagnostics: [
          diagnostic("AFSV018", "error", "The service package major version is incompatible."),
        ],
      };
    }
    const diagnostics: Diagnostic[] = [];
    if (ping.serviceVersion !== input.clientVersion) {
      diagnostics.push(
        diagnostic(
          "AFSV018",
          "warning",
          "The service and client package versions differ but share a compatible protocol.",
        ),
      );
    }
    return { status: "connected", client, metadata, diagnostics };
  } catch (error: unknown) {
    const clientError = error instanceof ServiceClientError ? error : undefined;
    return {
      status: clientError?.code === "AFSV012" ? "incompatible" : "unavailable",
      diagnostics: [
        diagnostic(
          clientError?.code ?? "AFSV013",
          "error",
          clientError?.message ?? "The BriefOnce local service could not be reached.",
        ),
      ],
    };
  }
}

export type AgentFoldServiceConnection =
  | {
      readonly connected: true;
      readonly client: AgentFoldServiceClient;
      readonly diagnostics: readonly Diagnostic[];
    }
  | { readonly connected: false; readonly diagnostics: readonly Diagnostic[] };

export async function connectToAgentFoldService(
  input: ConnectServiceClientInput,
): Promise<AgentFoldServiceConnection> {
  const result = await connectAgentFoldServiceClient(input);
  return result.status === "connected"
    ? { connected: true, client: result.client, diagnostics: result.diagnostics }
    : { connected: false, diagnostics: result.diagnostics };
}

export async function checkAgentFoldServiceAvailability(
  input: ConnectServiceClientInput,
): Promise<ServiceAvailability> {
  const connected = await connectAgentFoldServiceClient(input);
  if (connected.status !== "connected") {
    return { available: false, diagnostics: connected.diagnostics };
  }
  try {
    return {
      available: true,
      status: await connected.client.status(),
      diagnostics: connected.diagnostics,
    };
  } catch (error: unknown) {
    return {
      available: false,
      diagnostics: [
        diagnostic(
          error instanceof ServiceClientError ? error.code : "AFSV013",
          "error",
          "The BriefOnce local service could not be queried.",
        ),
      ],
    };
  }
}
