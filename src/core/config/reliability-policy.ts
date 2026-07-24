import { z } from "zod";

const maximumEventsSchema = z.number().int().min(100).max(10_000);
const retainedClosedSessionsSchema = z.number().int().min(10).max(1_000);

export const reliabilityConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    maximum_events_per_repository: maximumEventsSchema.optional(),
    retain_closed_sessions: retainedClosedSessionsSchema.optional(),
    interrupted_recovery_enabled: z.boolean().optional(),
  })
  .strict();

export const reliabilityPolicySchema = z
  .object({
    enabled: z.boolean(),
    maximumEventsPerRepository: maximumEventsSchema,
    retainClosedSessions: retainedClosedSessionsSchema,
    interruptedRecoveryEnabled: z.boolean(),
  })
  .strict();

export type ReliabilityConfig = z.infer<typeof reliabilityConfigSchema>;
export type ReliabilityPolicy = z.infer<typeof reliabilityPolicySchema>;

export const defaultReliabilityPolicy: ReliabilityPolicy = {
  enabled: true,
  maximumEventsPerRepository: 1_000,
  retainClosedSessions: 100,
  interruptedRecoveryEnabled: true,
};

export function resolveReliabilityPolicy(config?: ReliabilityConfig): ReliabilityPolicy {
  return reliabilityPolicySchema.parse({
    enabled: config?.enabled ?? defaultReliabilityPolicy.enabled,
    maximumEventsPerRepository:
      config?.maximum_events_per_repository ?? defaultReliabilityPolicy.maximumEventsPerRepository,
    retainClosedSessions:
      config?.retain_closed_sessions ?? defaultReliabilityPolicy.retainClosedSessions,
    interruptedRecoveryEnabled:
      config?.interrupted_recovery_enabled ?? defaultReliabilityPolicy.interruptedRecoveryEnabled,
  });
}
