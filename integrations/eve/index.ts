import { defineChannel, POST } from "eve/channels";
import type { SessionReader } from "eve/sessions";
import { z } from "zod";
import { fromProject, postToProject } from "../../lib/auth.ts";
import { errorName, log } from "../../lib/log.ts";
import {
  actionPath, deliveryReferenceSchema, deliverySchema, eveDeliveryPath, eveResultPath,
  projectIdentity, readJson, receiptSchema, stableId, type Action, type Delivery, type EveReceipt,
} from "../../lib/protocol.ts";

const optionsSchema = z.object({
  gatewayUrl: z.url().refine(value => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && url.pathname === "/"
      && !url.search && !url.hash;
  }, "Expected the HTTPS origin of the Buzz Gateway project"),
  gatewayProject: projectIdentity,
  actionKey: z.custom<() => Promise<string>>(value => typeof value === "function").optional(),
  acknowledgmentReaction: z.string().trim().min(1).max(24).optional(),
});
const resultRequest = deliveryReferenceSchema.extend({ receipt: receiptSchema });
type Reference = z.infer<typeof deliveryReferenceSchema>;
type ResponseAction = { kind: "reply"; text: string } | { kind: "reaction"; emoji: string } | { kind: "typing" };

export type BuzzChannelOptions = z.input<typeof optionsSchema>;

export function createBuzzChannel(input: BuzzChannelOptions) {
  const options = optionsSchema.parse(input);
  async function publish(reference: Reference, output: ResponseAction): Promise<void> {
    const { registrationId, namespace, eventId } = reference;
    const action: Action = { version: 1, registrationId, namespace, eventId, ...output };
    const response = await postToProject(options.gatewayUrl, actionPath, action, await options.actionKey?.());
    if (response.status !== 202) throw new Error(`Gateway action unavailable (${response.status})`);
  }

  async function reply(reference: Reference, text: string | undefined): Promise<void> {
    if (!text?.trim()) return;
    const trimmed = text.trim();
    await publish(reference, { kind: "reply", text: trimmed.length > 16_000 ? `${trimmed.slice(0, 15_999)}…` : trimmed });
  }

  return defineChannel({
    routes: [
      POST(eveDeliveryPath, async (request, { from, waitUntil }) => {
        if (!await fromProject(request, options.gatewayProject)) return new Response(null, { status: 403 });
        const input = await readJson(request).catch(() => undefined);
        const parsed = deliverySchema.safeParse(input);
        if (!parsed.success) return new Response(null, { status: 400 });
        const message = parsed.data;
        const receipt = await from(message.conversationId).send(`${marker(message)}\n${message.text}`, {
          auth: {
            authenticator: "buzz-gateway",
            issuer: `urn:buzz:${message.namespace}`,
            principalId: message.author,
            principalType: "user",
            attributes: { buzzPublicKey: message.author },
          },
          idempotencyKey: `buzz:${stableId(message.namespace, message.eventId)}`,
        });
        const report = (error: unknown) => log("debug", "eve_action_callback_pending", {
          registrationId: message.registrationId, eventId: message.eventId, error: errorName(error),
        });
        waitUntil(publish(message, { kind: "typing" }).catch(report));
        if (options.acknowledgmentReaction) {
          waitUntil(publish(message, { kind: "reaction", emoji: options.acknowledgmentReaction }).catch(report));
        }
        // Short turns publish promptly. The durable result endpoint covers slower turns and restarts.
        waitUntil(receipt.result({ signal: AbortSignal.timeout(8000) })
          .then(result => reply(message, result.reply)).catch(report));
        return Response.json({ sessionId: receipt.sessionId, deliveryId: receipt.deliveryId }, { status: 202 });
      }),
      POST(eveResultPath, async (request, { attachSession }) => {
        if (!await fromProject(request, options.gatewayProject)) return new Response(null, { status: 403 });
        const input = await readJson(request).catch(() => undefined);
        const parsed = resultRequest.safeParse(input);
        if (!parsed.success) return new Response(null, { status: 400 });
        const message = parsed.data;
        const result = await recordedReply(attachSession(message.receipt.sessionId), message, message.receipt,
          AbortSignal.any([request.signal, AbortSignal.timeout(6500)]));
        if (!result.settled) return new Response(null, { status: 202 });
        await reply(message, result.reply);
        return new Response(null, { status: 200 });
      }),
    ],
  });
}

function marker(reference: Pick<Reference, "namespace" | "eventId">): string {
  return `[Buzz event ${stableId(reference.namespace, reference.eventId)}]`;
}

/** Reads the text for the original input after a lost HTTP acknowledgment or callback. */
export async function recordedReply(
  session: SessionReader,
  reference: Pick<Delivery, "namespace" | "eventId">,
  receipt: EveReceipt,
  signal?: AbortSignal,
): Promise<{ settled: boolean; reply?: string }> {
  let deliveryId: string | undefined;
  let turnId: string | undefined;
  let settled = false;
  let refused = false;
  const parts = new Map<string, string>();
  const prefix = `${marker(reference)}\n`;
  for await (const event of session.stream({ follow: false, signal })) {
    if (event.type === "delivery.consumed" && !deliveryId) {
      const part = event.data.parts[0];
      if (part?.kind === "text" && part.text.startsWith(prefix)) {
        deliveryId = event.data.deliveryId;
        turnId = event.data.turnId;
      }
    }
    if (event.type === "content.completed" && turnId && event.scope?.turnId === turnId
      && event.data.phase === "reply" && event.data.kind === "text" && typeof event.data.value === "string") {
      parts.set(event.data.partId, event.data.value);
    }
    if (event.type === "delivery.settled") {
      if (event.data.deliveryId === deliveryId) settled = true;
      if (event.data.deliveryId === receipt.deliveryId && ["failed", "refused"].includes(event.data.outcome)) refused = true;
    }
    if (settled && parts.size) break;
  }
  return { settled: settled || refused, reply: parts.size ? [...parts.values()].join("\n\n") : undefined };
}
