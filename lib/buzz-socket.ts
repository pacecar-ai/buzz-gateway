import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { Event, EventTemplate } from "nostr-tools/pure";
import { verifiedEvent } from "./buzz.ts";
import type { Agent } from "./config.ts";
import { errorName, log } from "./log.ts";

type Signer = { sign(template: EventTemplate): Event; ownerTag?: string[] };
type Acknowledgment = ReturnType<typeof Promise.withResolvers<void>> & { timer: NodeJS.Timeout };

export class RelayRejectedError extends Error {
  readonly permanent: boolean;
  constructor(permanent: boolean) {
    super("The Buzz relay rejected an event");
    this.name = "RelayRejectedError";
    this.permanent = permanent;
  }
}

export class BuzzSocket {
  readonly agent: Agent;
  readonly signer: Signer;
  readonly #socket: WebSocket;
  readonly #ready = Promise.withResolvers<void>();
  readonly #closed = Promise.withResolvers<void>();
  readonly #acks = new Map<string, Acknowledgment>();
  readonly #subscriptionId = randomUUID();
  #processing = Promise.resolve();
  #queued = 0;
  #onEvent?: (event: Event) => Promise<void>;
  #onEndOfStoredEvents?: () => Promise<void>;

  constructor(agent: Agent, signer: Signer) {
    this.agent = agent;
    this.signer = signer;
    this.#socket = new WebSocket(agent.relayUrl, { handshakeTimeout: 20_000, maxPayload: 512_000, perMessageDeflate: false });
    // The connection may close before start() attaches its waiter.
    void this.#ready.promise.catch(() => {});
    this.#socket.on("message", raw => this.#read(String(raw)));
    this.#socket.on("error", () => this.#socket.terminate());
    this.#socket.once("close", () => {
      const error = new Error("Buzz connection closed");
      this.#ready.reject(error);
      for (const ack of this.#acks.values()) {
        clearTimeout(ack.timer);
        ack.reject(error);
      }
      this.#acks.clear();
      this.#closed.resolve();
    });
  }

  get connected(): boolean { return this.#socket.readyState === WebSocket.OPEN; }

  get closed(): Promise<void> { return this.#closed.promise; }

  async start(): Promise<void> {
    const timer = setTimeout(() => this.close(), 25_000);
    try {
      await this.#ready.promise;
    } finally {
      clearTimeout(timer);
    }
  }

  subscribe(since: number, onEvent: (event: Event) => Promise<void>, onEndOfStoredEvents: () => Promise<void>): void {
    this.#onEvent = onEvent;
    this.#onEndOfStoredEvents = onEndOfStoredEvents;
    const channels = [...this.agent.channels, ...this.agent.directMessages.map(dm => dm.channelId)];
    if (channels.length > 0) this.#send(["REQ", this.#subscriptionId, { kinds: [9], "#h": channels, since }]);
  }

  publish(event: Event): Promise<void> { return this.#sendWithAck("EVENT", event); }

  close(): void { this.#socket.terminate(); }

  async drained(): Promise<void> { await this.#processing; }

  #send(frame: unknown): void {
    if (!this.connected) throw new Error("Buzz connection is closed");
    this.#socket.send(JSON.stringify(frame));
  }

  #sendWithAck(command: "AUTH" | "EVENT", event: Event): Promise<void> {
    const existing = this.#acks.get(event.id);
    if (existing) return existing.promise;
    const ack = Promise.withResolvers<void>();
    const timer = setTimeout(() => {
      this.#acks.delete(event.id);
      ack.reject(new Error("Buzz relay acknowledgment timed out"));
    }, 8000);
    this.#acks.set(event.id, { ...ack, timer });
    try {
      this.#send([command, event]);
    } catch (error) {
      clearTimeout(timer);
      this.#acks.delete(event.id);
      ack.reject(error);
    }
    return ack.promise;
  }

  #read(raw: string): void {
    let frame: unknown;
    try { frame = JSON.parse(raw); } catch { return; }
    if (!Array.isArray(frame)) return;
    switch (frame[0]) {
      case "AUTH":
        if (typeof frame[1] === "string" && frame[1].length <= 4096) void this.#authenticate(frame[1]);
        break;
      case "OK": {
        const ack = this.#acks.get(frame[1]);
        if (!ack || typeof frame[2] !== "boolean") return;
        this.#acks.delete(frame[1]);
        clearTimeout(ack.timer);
        const code = typeof frame[3] === "string" ? frame[3].split(":", 1)[0] : "";
        if (frame[2] || code === "duplicate") ack.resolve();
        else ack.reject(new RelayRejectedError(["invalid", "blocked", "restricted", "forbidden"].includes(code)));
        break;
      }
      case "EVENT": {
        if (frame[1] !== this.#subscriptionId || !this.#onEvent) return;
        const event = verifiedEvent(frame[2]);
        const onEvent = this.#onEvent;
        if (event) this.#enqueue(() => onEvent(event));
        break;
      }
      case "EOSE":
        if (frame[1] === this.#subscriptionId && this.#onEndOfStoredEvents) this.#enqueue(this.#onEndOfStoredEvents);
        break;
      case "CLOSED":
        if (frame[1] === this.#subscriptionId) this.close();
        break;
    }
  }

  async #authenticate(challenge: string): Promise<void> {
    try {
      const tags = [["relay", this.agent.relayUrl], ["challenge", challenge]];
      if (this.signer.ownerTag) tags.push(this.signer.ownerTag);
      await this.#sendWithAck("AUTH", this.signer.sign({ kind: 22242, created_at: Math.floor(Date.now() / 1000), tags, content: "" }));
      this.#ready.resolve();
    } catch (error) {
      log("warn", "relay_auth_failed", { registrationId: this.agent.id, error: errorName(error) });
      this.#ready.reject(error);
      this.close();
    }
  }

  #enqueue(task: () => Promise<void>): void {
    if (this.#queued >= 512) {
      log("warn", "relay_backlog_full", { registrationId: this.agent.id });
      this.close();
      return;
    }
    this.#queued += 1;
    this.#processing = this.#processing.then(async () => {
      if (this.connected) await task();
    }).catch(error => {
      log("warn", "relay_ingress_retry", { registrationId: this.agent.id, error: errorName(error) });
      this.close();
    }).finally(() => { this.#queued -= 1; });
  }
}
