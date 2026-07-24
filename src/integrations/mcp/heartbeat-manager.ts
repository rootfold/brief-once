import type { McpStderrLogger } from "./mcp-context.js";
import type { AgentFoldServiceClient } from "../service/service-client.js";
import { nodeServiceScheduler, type ServiceScheduler } from "../service/lease-monitor.js";

interface HeartbeatRegistration {
  readonly sessionId: string;
  readonly handle: unknown;
}

export interface McpHeartbeatManagerOptions {
  readonly client: AgentFoldServiceClient;
  readonly logger: McpStderrLogger;
  readonly scheduler?: ServiceScheduler;
}

export class McpHeartbeatManager {
  private readonly registrations = new Map<string, HeartbeatRegistration>();
  private readonly scheduler: ServiceScheduler;
  private shuttingDown = false;

  constructor(private readonly options: McpHeartbeatManagerOptions) {
    this.scheduler = options.scheduler ?? nodeServiceScheduler;
  }

  start(sessionId: string, intervalSeconds: number): void {
    this.stop(sessionId);
    const handle = this.scheduler.setInterval(() => {
      void this.options.client.heartbeat(sessionId).catch(() => {
        this.options.logger.error(
          "AFSV030: BriefOnce service heartbeat failed; restart the service if it remains unavailable.",
        );
      });
    }, intervalSeconds * 1_000);
    this.registrations.set(sessionId, { sessionId, handle });
  }

  stop(sessionId: string): void {
    const registration = this.registrations.get(sessionId);
    if (registration === undefined) return;
    this.scheduler.clearInterval(registration.handle);
    this.registrations.delete(sessionId);
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    const sessionIds = [...this.registrations.keys()];
    for (const sessionId of sessionIds) this.stop(sessionId);
    await Promise.all(
      sessionIds.map(async (sessionId) => {
        try {
          await this.options.client.detach(sessionId);
        } catch {
          this.options.logger.debug("Best-effort service session detach did not complete.");
        }
      }),
    );
  }
}
