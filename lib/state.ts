import { BlobNotFoundError, BlobPreconditionFailedError, get, put } from "@vercel/blob";
import type { Delivery, EveReceipt } from "./protocol.ts";

export type Versioned<T> = { value: T; etag: string };

export interface State {
  read<T>(path: string): Promise<Versioned<T> | null>;
  write<T>(path: string, value: T, ttlDays?: number): Promise<void>;
  create<T>(path: string, value: T, ttlDays?: number): Promise<boolean>;
  replace<T>(path: string, value: T, etag: string, ttlDays?: number): Promise<boolean>;
}

export type Target = {
  channelId: string;
  rootId: string | null;
  author: string;
  sourceEventId: string;
};

export type DeliveryRecord = {
  delivery: Omit<Delivery, "text">;
  target: Target;
  receipt?: EveReceipt;
  completed?: boolean;
};

export class BlobState implements State {
  async read<T>(path: string): Promise<Versioned<T> | null> {
    try {
      const result = await get(path, { access: "private", useCache: false, abortSignal: AbortSignal.timeout(8000) });
      if (!result || result.statusCode !== 200) return null;
      return { value: await new Response(result.stream).json() as T, etag: result.blob.etag };
    } catch (error) {
      if (error instanceof BlobNotFoundError) return null;
      throw error;
    }
  }

  async create<T>(path: string, value: T, ttlDays?: number): Promise<boolean> {
    try {
      await put(path, JSON.stringify(value), {
        access: "private", contentType: "application/json", addRandomSuffix: false,
        allowOverwrite: false, ttlDays, abortSignal: AbortSignal.timeout(8000),
      });
      return true;
    } catch (error) {
      if (error instanceof BlobPreconditionFailedError || await this.read(path)) return false;
      throw error;
    }
  }

  async write<T>(path: string, value: T, ttlDays?: number): Promise<void> {
    await put(path, JSON.stringify(value), {
      access: "private", contentType: "application/json", allowOverwrite: true,
      cacheControlMaxAge: 60, ttlDays, abortSignal: AbortSignal.timeout(8000),
    });
  }

  async replace<T>(path: string, value: T, etag: string, ttlDays?: number): Promise<boolean> {
    try {
      await put(path, JSON.stringify(value), {
        access: "private", contentType: "application/json", allowOverwrite: true,
        ifMatch: etag, ttlDays, abortSignal: AbortSignal.timeout(8000),
      });
      return true;
    } catch (error) {
      if (error instanceof BlobPreconditionFailedError) return false;
      throw error;
    }
  }
}
