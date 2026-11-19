import { PollingQueueClient } from "@vercel/queue";
import { gatewayRegion } from "./config.ts";
import { actionId, inboxTopic, outboxTopic, queueRetentionSeconds, stableId, type ActionJob, type Delivery } from "./protocol.ts";

export type InboxJob =
  | { kind: "message"; delivery: Delivery }
  | { kind: "reconcile"; registrationId: string; namespace: string; eventId: string };

export interface Outbox {
  sendAction(job: ActionJob): Promise<void>;
}

export class GatewayQueue implements Outbox {
  readonly #client = new PollingQueueClient({ region: gatewayRegion(), deploymentId: null });

  async sendDelivery(delivery: Delivery): Promise<void> {
    await this.#client.send<InboxJob>(inboxTopic, { kind: "message", delivery }, {
      idempotencyKey: stableId(delivery.namespace, delivery.eventId), retentionSeconds: queueRetentionSeconds,
    });
  }

  async sendReconciliation(delivery: Pick<Delivery, "registrationId" | "namespace" | "eventId">): Promise<void> {
    const { registrationId, namespace, eventId } = delivery;
    await this.#client.send<InboxJob>(inboxTopic, { kind: "reconcile", registrationId, namespace, eventId }, {
      idempotencyKey: stableId(namespace, eventId, "reconcile"), retentionSeconds: queueRetentionSeconds,
      delaySeconds: 30,
    });
  }

  async sendAction(job: ActionJob): Promise<void> {
    await this.#client.send(outboxTopic, job, {
      idempotencyKey: actionId(job.action),
      retentionSeconds: job.action.kind === "typing" ? 60 : queueRetentionSeconds,
    });
  }

  async poll(topic: typeof inboxTopic | typeof outboxTopic, handler: (job: unknown) => Promise<void>): Promise<boolean> {
    const result = await this.#client.receive(topic, "buzz-gateway", handler, {
      limit: 1, visibilityTimeoutSeconds: 30, cursorFallback: "earliest",
    });
    return result.ok;
  }
}
