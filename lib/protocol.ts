import { createHash } from "node:crypto";
import { z } from "zod";

export const hexId = z.string().regex(/^[a-f0-9]{64}$/);
export const registrationId = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);
export const projectIdentity = z.object({
  teamSlug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  teamId: z.string().regex(/^team_[A-Za-z0-9]+$/),
  projectId: z.string().regex(/^prj_[A-Za-z0-9]+$/),
  environment: z.string().regex(/^[A-Za-z0-9_-]+$/).default("production"),
  issuerMode: z.enum(["team", "global"]).default("team"),
});
export type ProjectIdentity = z.infer<typeof projectIdentity>;

export const deliverySchema = z.object({
  version: z.literal(1),
  registrationId,
  namespace: hexId,
  eventId: hexId,
  conversationId: hexId,
  author: hexId,
  direct: z.boolean(),
  text: z.string().min(1).max(16000),
});
export type Delivery = z.infer<typeof deliverySchema>;
export const deliveryReferenceSchema = deliverySchema.omit({ text: true });

const actionContext = { version: z.literal(1), registrationId, namespace: hexId, eventId: hexId };
export const actionSchema = z.discriminatedUnion("kind", [
  z.object({ ...actionContext, kind: z.literal("reply"), text: z.string().trim().min(1).max(16000) }),
  z.object({ ...actionContext, kind: z.literal("reaction"), emoji: z.string().trim().min(1).max(24) }),
  z.object({ ...actionContext, kind: z.literal("typing") }),
]);
export type Action = z.infer<typeof actionSchema>;
export const actionJobSchema = z.object({ action: actionSchema, queuedAt: z.number().int().positive() });
export type ActionJob = z.infer<typeof actionJobSchema>;

export const receiptSchema = z.object({
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
  deliveryId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
});
export type EveReceipt = z.infer<typeof receiptSchema>;

export const inboxTopic = "buzz-gateway-inbox";
export const outboxTopic = "buzz-gateway-outbox";
export const queueRetentionSeconds = 86400;
export const receiptRetentionDays = 2;
export const typingLifetimeMs = 10_000;
export const eveDeliveryPath = "/integrations/buzz/events";
export const eveResultPath = "/integrations/buzz/result";
export const actionPath = "/api/actions";
export const healthPath = "gateway/daemon-health.json";

export function stableId(...parts: string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function deliveryPath(reference: Pick<Delivery, "namespace" | "eventId">): string {
  return `${reference.namespace}/delivery/${reference.eventId}.json`;
}

export function actionId(action: Action): string {
  return stableId(action.namespace, action.eventId, action.kind, action.kind === "reaction" ? action.emoji : "");
}

export async function readJson(request: Request, maxBytes = 48_000): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json") || !request.body) {
    throw new Error("Expected a JSON request");
  }
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let body = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("JSON request exceeds size limit");
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(body + decoder.decode());
  } finally {
    reader.releaseLock();
  }
}
