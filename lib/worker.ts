import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { Event } from "nostr-tools/pure";
import { z } from "zod";
import { postToProject } from "./auth.ts";
import { publishActivity } from "./activity.ts";
import { publishAgentProfile, type PublishedProfile } from "./agent-profile.ts";
import { actionEvent, inboundMessage, roomDirectness } from "./buzz.ts";
import { BuzzSocket, RelayRejectedError } from "./buzz-socket.ts";
import type { Agent } from "./config.ts";
import { readConnectProfile } from "./connect-profile.ts";
import { CredentialRefusedError, loadSigner, type Signer } from "./credentials.ts";
import { desktopGrantPath, WaitingForOwner } from "./desktop-grants.ts";
import { errorName, log } from "./log.ts";
import { readRooms, relaySigningKey, sameRooms, type BuzzRooms } from "./memberships.ts";
import { ownerProofFor } from "./owner-proof.ts";
import {
  actionId, actionJobSchema, deliveryPath, deliverySchema, deliveryStatusHeader, eveDeliveryPath, eveResultPath, healthPath,
  hexId, inboxTopic, outboxTopic, queueRetentionSeconds, receiptRetentionDays, receiptSchema, registrationId, typingLifetimeMs,
} from "./protocol.ts";
import type { GatewayQueue } from "./queue.ts";
import type { DeliveryRecord, State } from "./state.ts";

const overlapSeconds = 120;
const leaseDurationMs = 45_000;
const issuerEpoch = () => Math.floor(Date.now() / 1000);
const reconcileSchema = z.object({ kind: z.literal("reconcile"), registrationId, namespace: hexId, eventId: hexId });
const incoming = z.discriminatedUnion("kind", [z.object({ kind: z.literal("message"), delivery: deliverySchema }), reconcileSchema]);
type Lease = { owner: string; expiresAt: number };
type LiveAgent = {
  socket: BuzzSocket;
  lease: Lease;
  membership?: { relayKey: string; rooms: BuzzRooms };
  publishedProfile?: PublishedProfile;
};
type PublishedAction = { event?: Event; published?: boolean; rejected?: boolean };
type WorkerQueue = Pick<GatewayQueue, "poll" | "sendDelivery" | "sendReconciliation">;

export class GatewayWorker {
  readonly #agents: Map<string, Agent>;
  readonly #state: State;
  readonly #queue: WorkerQueue;
  readonly #post: typeof postToProject;
  readonly #active = new Map<string, LiveAgent>();
  readonly #waiting = new Set<string>();
  readonly #typing = new Map<string, { agent: Agent; record: DeliveryRecord; expires: number }>();
  readonly #owner = randomUUID();

  constructor(
    agents: Map<string, Agent>,
    state: State,
    queue: WorkerQueue,
    post = postToProject,
  ) {
    this.#agents = agents;
    this.#state = state;
    this.#queue = queue;
    this.#post = post;
  }

  async run(signal: AbortSignal): Promise<void> {
    log("info", "gateway_daemon_started", { registrations: this.#agents.size });
    const jobs = [this.#heartbeat(signal)];
    for (const agent of this.#agents.values()) jobs.push(this.#runAgent(agent, signal));
    if (this.#agents.size) {
      jobs.push(this.#poll(inboxTopic, job => this.#deliver(job), signal));
      jobs.push(this.#poll(outboxTopic, job => this.#publish(job), signal));
      jobs.push(this.#typingPulses(signal));
    }
    await Promise.all(jobs);
  }

  async #heartbeat(signal: AbortSignal): Promise<void> {
    let reported = false;
    while (!signal.aborted) {
      try {
        const heartbeat = { at: Date.now(), configured: this.#agents.size, connected: this.#active.size,
          waiting: this.#waiting.size, online: [...this.#active.keys()] };
        await this.#state.write(healthPath, heartbeat, 1);
        if (!reported) log("info", "gateway_storage_ready", { registrations: this.#agents.size });
        reported = true;
      } catch (error) {
        log("error", "gateway_storage_retry", { error: errorName(error) });
      }
      await pause(60_000, signal);
    }
  }

  async #poll(topic: typeof inboxTopic | typeof outboxTopic, handler: (input: unknown) => Promise<void>, signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      try {
        const processed = await this.#queue.poll(topic, async job => {
          if (signal.aborted) throw new Error("Daemon is stopping");
          await handler(job);
        });
        failures = 0;
        if (!processed) await pause(this.#active.size ? 750 : 4000, signal);
      } catch (error) {
        failures += 1;
        if (failures === 1 || failures % 10 === 0) {
          log("warn", "queue_retry", { topic, error: errorName(error), failures });
        }
        await pause(Math.min(10_000, 1000 * failures), signal);
      }
    }
  }

  async #runAgent(agent: Agent, signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      try {
        // A pending installation needs no relay lease. Pick up its grant without a redeploy.
        if (this.#waiting.has(agent.id)) {
          const installed = await this.#state.read<{ sealed?: unknown }>(desktopGrantPath(agent));
          if (!installed?.value.sealed) {
            await pause(8000, signal);
            continue;
          }
          this.#waiting.delete(agent.id);
        }
        const lease = await this.#claim(agent);
        if (!lease) {
          await pause(4000, signal);
          continue;
        }
        try {
          await this.#relaySession(agent, await loadSigner(agent, this.#state), lease, signal);
        } finally {
          await this.#release(agent);
        }
        failures = 0;
      } catch (error) {
        if (error instanceof WaitingForOwner) {
          this.#waiting.add(agent.id);
          log("info", "buzz_approval_pending", { registrationId: agent.id });
          continue;
        }
        if (error instanceof CredentialRefusedError) {
          log("warn", "relay_installation_refused", { registrationId: agent.id });
          return;
        }
        failures += 1;
        log("warn", "relay_reconnecting", { registrationId: agent.id, error: errorName(error), failures });
      }
      await pause(Math.min(30_000, 2000 * 2 ** Math.min(failures, 4)) + Math.floor(Math.random() * 500), signal);
    }
  }

  async #claim(agent: Agent, renewing = false): Promise<Lease | undefined> {
    const path = `relay/${agent.relayIdentity}/lease.json`;
    const existing = await this.#state.read<Lease>(path);
    const now = Date.now();
    if (renewing && (existing?.value.owner !== this.#owner || existing.value.expiresAt <= now)) return;
    if (existing && existing.value.owner !== this.#owner && existing.value.expiresAt > now) return;
    const lease = { owner: this.#owner, expiresAt: now + leaseDurationMs };
    const won = existing
      ? await this.#state.replace(path, lease, existing.etag)
      : await this.#state.create(path, lease);
    if (won) return lease;
  }

  async #release(agent: Agent): Promise<void> {
    const path = `relay/${agent.relayIdentity}/lease.json`;
    const current = await this.#state.read<Lease>(path);
    if (current?.value.owner === this.#owner) await this.#state.replace(path, { owner: this.#owner, expiresAt: 0 }, current.etag);
  }

  async #relaySession(agent: Agent, signer: Signer, lease: Lease, signal: AbortSignal): Promise<void> {
    const socket = new BuzzSocket(agent, signer);
    const stop = new AbortController();
    const end = () => { stop.abort(); socket.close(); };
    signal.addEventListener("abort", end, { once: true });
    if (signal.aborted) end();
    const active: LiveAgent = { lease, socket };
    const refreshAssertion = signer.assertion
      ? setTimeout(end, Math.max(0, signer.assertion.expiresAt - Date.now() - 5000))
      : undefined;
    const renewal = this.#maintainRelay(agent, active, stop.signal).catch(error => {
      log("warn", "relay_lease_lost", { registrationId: agent.id, error: errorName(error) });
      end();
    });
    try {
      await socket.start();
      if (agent.roomAccess === "membership") {
        const relayKey = await relaySigningKey(agent.relayUrl);
        active.membership = { relayKey, rooms: await readRooms(socket, relayKey) };
      }
      const channels = active.membership
        ? [...active.membership.rooms.keys()]
        : [...agent.channels, ...agent.directMessages.map(room => room.channelId)];
      const checkpointPath = `${agent.namespace}/checkpoint.json`;
      const checkpoint = await this.#state.read<{ since: number; rooms?: string[] }>(checkpointPath);
      const since = Math.max(0, (checkpoint?.value.since ?? issuerEpoch()) - overlapSeconds);
      const previousRooms = new Set(checkpoint?.value.rooms);
      const roomStarts = new Map<string, number>();
      for (const [id, room] of active.membership?.rooms ?? []) {
        // A mention can arrive immediately after an invite, before membership refresh or a deployment.
        roomStarts.set(id, previousRooms.has(id) ? since : Math.max(issuerEpoch() - queueRetentionSeconds, room.rosterAt));
      }
      let roomsChanged = Boolean(active.membership && (!checkpoint?.value.rooms || previousRooms.size !== channels.length
        || channels.some(id => !previousRooms.has(id))));
      let stored = false;
      let highWater = checkpoint?.value.since ?? since;
      let lastSaved = highWater;
      const save = async () => {
        if (!this.#isLive(active) || (highWater <= lastSaved && !roomsChanged)) return;
        const previous = await this.#state.read<{ since: number }>(checkpointPath);
        const next = { since: Math.max(previous?.value.since ?? 0, highWater), ...(active.membership && { rooms: channels }) };
        if (!this.#isLive(active)) return;
        const ok = previous
          ? await this.#state.replace(checkpointPath, next, previous.etag)
          : await this.#state.create(checkpointPath, next);
        if (ok) { lastSaved = next.since; roomsChanged = false; }
      };
      this.#active.set(agent.id, active);
      socket.subscribe(roomStarts.size ? Math.min(...roomStarts.values()) : since, channels, async event => {
        if (!this.#isLive(active)) return;
        const roomId = event.tags.find(tag => tag[0] === "h")?.[1];
        if (roomId && event.created_at < (roomStarts.get(roomId) ?? since)) return;
        await this.#ingest(agent, event, active.membership?.rooms);
        highWater = Math.max(highWater, Math.min(event.created_at, issuerEpoch()));
        // Stored events can arrive newest first. Commit the catch-up checkpoint after EOSE.
        if (stored && highWater - lastSaved >= 30) await save();
      }, async () => { stored = true; await save(); });
      if (!channels.length) await save();
      log("info", "relay_authenticated", { registrationId: agent.id, rooms: channels.length });
      if (agent.profile) await this.#publishProfile(active, agent.profile);
      if (agent.profileFromConnector && agent.credentialConnector) {
        await this.#refreshConnectProfile(active, agent.credentialConnector);
      }
      await this.#presence(agent, socket, "online");
      await socket.closed;
    } finally {
      clearTimeout(refreshAssertion);
      this.#active.delete(agent.id);
      end();
      await Promise.all([renewal, socket.drained()]);
      log("info", "relay_disconnected", { registrationId: agent.id });
    }
  }

  async #maintainRelay(agent: Agent, active: LiveAgent, signal: AbortSignal): Promise<void> {
    let ticks = 0;
    while (!signal.aborted) {
      await pause(14_000, signal);
      if (signal.aborted) return;
      const lease = await this.#claim(agent, true);
      if (!lease) throw new Error("Relay lease expired");
      active.lease = lease;
      if (active.membership) {
        const { relayKey, rooms } = active.membership;
        const next = await readRooms(active.socket, relayKey);
        if (!sameRooms(rooms, next)) {
          log("info", "buzz_membership_changed", { registrationId: agent.id, rooms: next.size });
          // Reconnect with the updated filter and the normal replay checkpoint.
          active.socket.close();
          return;
        }
      }
      ticks += 1;
      if (this.#active.get(agent.id) !== active) continue;
      if (ticks % 4 === 0) await this.#presence(agent, active.socket, "online");
      if (agent.profileFromConnector && agent.credentialConnector) {
        const ownership = active.socket.signer.profileOwnership;
        let repair = false;
        if (!active.publishedProfile?.attested && ownership?.read) {
          try {
            const proof = ownerProofFor(agent.pubkey, ownership.owner, ownership.proof, 0, issuerEpoch()) ?? await ownership.read();
            if (proof) { ownership.proof = proof; repair = true; }
          } catch (error) {
            log("warn", "buzz_profile_ownership_retry", { registrationId: agent.id, error: errorName(error) });
          }
        }
        if (repair || ticks % 20 === 0) await this.#refreshConnectProfile(active, agent.credentialConnector);
      }
    }
  }

  async #refreshConnectProfile(active: LiveAgent, connector: string): Promise<void> {
    try {
      const profile = await readConnectProfile(connector);
      if (this.#isLive(active)) await this.#publishProfile(active, profile);
    } catch (error) {
      log("warn", "buzz_profile_sync_failed", { registrationId: active.socket.agent.id, error: errorName(error) });
    }
  }

  async #publishProfile(active: LiveAgent, profile: { name: string; description?: string; picture?: string }): Promise<void> {
    const previous = active.publishedProfile;
    active.publishedProfile = await publishAgentProfile(active.socket, this.#state, profile, previous);
    if (active.publishedProfile !== previous) log("info", "buzz_profile_published", {
      registrationId: active.socket.agent.id, teams: active.publishedProfile.attested,
    });
  }

  async #presence(agent: Agent, socket: BuzzSocket, status: "online"): Promise<void> {
    try {
      await socket.publish(socket.signer.sign({ kind: 20001, tags: [], content: status, created_at: issuerEpoch() }));
    } catch (error) {
      log("debug", "presence_publish_failed", { registrationId: agent.id, error: errorName(error) });
    }
  }

  #isLive(active: LiveAgent): boolean { return active.socket.connected && active.lease.expiresAt > Date.now(); }

  async #ingest(agent: Agent, event: Event, rooms?: BuzzRooms): Promise<void> {
    if ([...this.#agents.values()].some(candidate => candidate.pubkey === event.pubkey)) return;
    const route = inboundMessage(agent, event, rooms);
    if (!route) return;
    const { delivery, target, addressed } = route;
    const threadPath = `${agent.namespace}/thread/${delivery.conversationId}.json`;
    if (!addressed && !await this.#state.read(threadPath)) return;
    const path = deliveryPath(delivery);
    const previous = await this.#state.read<DeliveryRecord>(path);
    if (previous?.value.receipt || previous?.value.completed) return;
    if (!previous) {
      const { text: _text, ...metadata } = delivery;
      await this.#state.create<DeliveryRecord>(path, { delivery: metadata, target }, receiptRetentionDays);
    }
    // The Blob record establishes routing authority before eve can send actions.
    await this.#queue.sendDelivery(delivery);
    if (addressed && !delivery.direct) await this.#state.create(threadPath, { joinedAt: Date.now() });
    log("info", "inbound_queued", { registrationId: agent.id, eventId: delivery.eventId });
  }

  async #deliver(input: unknown): Promise<void> {
    const parsed = incoming.safeParse(input);
    if (!parsed.success) { log("warn", "invalid_inbox_job"); return; }
    const job = parsed.data;
    const reference = job.kind === "message" ? job.delivery : job;
    const agent = this.#agents.get(reference.registrationId);
    if (!agent || agent.namespace !== reference.namespace) { log("warn", "inbox_registration_retired"); return; }
    const path = deliveryPath(reference);
    const record = await this.#state.read<DeliveryRecord>(path);
    if (!record || record.value.completed || !this.#deliveryAllowed(agent, record.value)) return;
    const location = { community: new URL(agent.relayUrl).origin, roomId: record.value.target.channelId };
    const settleDenied = async (response: Response): Promise<boolean> => {
      if (response.status !== 403 || response.headers.get(deliveryStatusHeader) !== "denied") return false;
      await updateDelivery(this.#state, path, current => ({ ...current, completed: true }));
      log("info", "eve_delivery_denied", { registrationId: agent.id, eventId: reference.eventId });
      return true;
    };
    if (job.kind === "reconcile") {
      if (!record.value.receipt) throw new Error("Waiting for eve delivery receipt");
      const response = await this.#post(agent.eveUrl, eveResultPath, { ...record.value.delivery, ...location, receipt: record.value.receipt });
      if (await settleDenied(response)) return;
      if (response.status !== 200) {
        log(response.status === 202 ? "debug" : "warn", "eve_result_retry", {
          registrationId: agent.id, eventId: reference.eventId, status: response.status,
        });
        throw new Error("eve result pending or unavailable");
      }
      await updateDelivery(this.#state, path, current => ({ ...current, completed: true }));
      log("info", "delivery_reconciled", { registrationId: agent.id, eventId: reference.eventId });
      return;
    }
    if (!record.value.receipt) {
      const response = await this.#post(agent.eveUrl, eveDeliveryPath, { ...job.delivery, ...location });
      if (await settleDenied(response)) return;
      if (response.status !== 202) {
        log("warn", "eve_delivery_retry", { registrationId: agent.id, eventId: reference.eventId, status: response.status });
        throw new Error("eve admission unavailable");
      }
      const receipt = receiptSchema.parse(await response.json());
      await updateDelivery(this.#state, path, current => ({ ...current, receipt: current.receipt ?? receipt }));
      log("info", "eve_delivery_admitted", { registrationId: agent.id, eventId: reference.eventId });
    }
    await this.#queue.sendReconciliation(reference);
  }

  async #typingPulses(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await pause(4000, signal);
      if (signal.aborted) return;
      await Promise.all([...this.#typing].map(async ([key, { agent, record, expires }]) => {
        const active = this.#active.get(agent.id);
        try {
          if (!active || expires < Date.now() || !this.#isLive(active) || !this.#deliveryAllowed(agent, record)) {
            this.#typing.delete(key);
            return;
          }
          const draft = actionEvent({ ...record.delivery, kind: "typing" }, record.target, Date.now());
          await active.socket.publish(active.socket.signer.sign(draft));
        } catch (error) {
          log("debug", "typing_pulse_failed", { registrationId: agent.id, error: errorName(error) });
        }
      }));
    }
  }

  async #publish(input: unknown): Promise<void> {
    const parsed = actionJobSchema.safeParse(input);
    if (!parsed.success) { log("warn", "invalid_outbox_job"); return; }
    const { action, queuedAt } = parsed.data;
    const agent = this.#agents.get(action.registrationId);
    if (!agent || agent.namespace !== action.namespace) { log("warn", "outbox_registration_retired"); return; }
    if (action.kind === "typing" && Date.now() - queuedAt > typingLifetimeMs) return;
    const active = this.#active.get(agent.id);
    if (!active || !this.#isLive(active)) throw new Error("Waiting for an authenticated Buzz connection");
    const id = actionId(action);
    const path = `${agent.namespace}/outbox/${id}.json`;
    const record = await this.#state.read<DeliveryRecord>(deliveryPath(action));
    if (!record || !this.#deliveryAllowed(agent, record.value)) return;
    const { target } = record.value;
    const pulseKey = deliveryPath(action);
    if (action.kind === "status") {
      const busy = await publishActivity(this.#state, {
        sign: draft => active.socket.signer.sign(draft),
        publish: event => {
          if (!this.#isLive(active)) throw new Error("Relay lease expired before activity publication");
          return active.socket.publish(event);
        },
      }, action, target, queuedAt);
      if (busy && !record.value.completed) this.#typing.set(pulseKey, { agent, record: record.value, expires: Date.now() + 90000 });
      else this.#typing.delete(pulseKey);
      log("debug", "buzz_status_published", { registrationId: agent.id, eventId: action.eventId, revision: action.revision });
      return;
    }
    if (action.kind === "typing" && this.#typing.has(pulseKey) && !record.value.completed) {
      this.#typing.get(pulseKey)!.expires = Date.now() + 90000;
    }
    if (action.kind === "reply") this.#typing.delete(pulseKey);
    let saved = action.kind === "typing" ? null : await this.#state.read<PublishedAction>(path);
    if (saved?.value.published || saved?.value.rejected) return;
    if (!saved && action.kind !== "typing") {
      const event = active.socket.signer.sign(actionEvent(action, target, queuedAt));
      await this.#state.create<PublishedAction>(path, { event }, receiptRetentionDays);
      saved = await this.#state.read<PublishedAction>(path);
      if (saved?.value.published || saved?.value.rejected) return;
      if (!saved?.value.event) throw new Error("Signed publish record unavailable");
    }
    if (!this.#isLive(active)) throw new Error("Relay lease expired before publish");
    const event = saved?.value.event ?? active.socket.signer.sign(actionEvent(action, target, queuedAt));
    try {
      await active.socket.publish(event);
    } catch (error) {
      if (!(error instanceof RelayRejectedError) || !error.permanent) throw error;
      if (saved) await this.#state.replace<PublishedAction>(path, { rejected: true }, saved.etag, receiptRetentionDays);
      log("warn", "buzz_publish_rejected", { registrationId: agent.id, eventId: action.eventId, actionId: id, kind: action.kind });
      return;
    }
    if (saved) {
      const updated = await this.#state.replace<PublishedAction>(path, { published: true }, saved.etag, receiptRetentionDays);
      if (!updated) throw new Error("Publish receipt changed concurrently");
    }
    log(action.kind === "typing" ? "debug" : "info", "buzz_action_published", {
      registrationId: agent.id, eventId: action.eventId, actionId: id, kind: action.kind,
    });
  }

  #deliveryAllowed(agent: Agent, record: DeliveryRecord): boolean {
    const active = this.#active.get(agent.id);
    if (agent.roomAccess === "membership" && (!active || !this.#isLive(active) || !active.membership)) {
      throw new Error("Waiting for a Buzz membership snapshot");
    }
    if (record.delivery.visibility === "private" && agent.roomAccess === "membership"
      && active?.membership?.rooms.get(record.target.channelId)?.visibility !== "private") return false;
    const { delivery, target } = record;
    return roomDirectness(agent, target.channelId, target.author, active?.membership?.rooms) === delivery.direct;
  }
}

async function updateDelivery(state: State, path: string, update: (record: DeliveryRecord) => DeliveryRecord): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const entry = await state.read<DeliveryRecord>(path);
    if (!entry) throw new Error("Delivery receipt disappeared");
    if (await state.replace(path, update(entry.value), entry.etag, receiptRetentionDays)) return;
  }
  throw new Error("Delivery receipt changed concurrently");
}

async function pause(ms: number, signal: AbortSignal): Promise<void> {
  try { await sleep(ms, undefined, { signal }); } catch (error) { if (!signal.aborted) throw error; }
}
