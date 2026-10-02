import type { IncomingHttpHeaders } from 'node:http';
export interface Peer { id: string; url: string; }
export interface PeerOptions {
  method?: string; key?: string; headers?: Record<string, string>; body?: unknown; signal?: AbortSignal;
  timeout?: number; retries?: number; retryUnsafe?: boolean; idempotencyKey?: string;
}
export interface TransportRequest { peer: Peer; url: URL; method: string; headers: Record<string, string>; body?: unknown; signal: AbortSignal; maxResponseBytes: number; }
export interface TransportResponse { statusCode: number; headers: IncomingHttpHeaders; body: Buffer; }
export class PeerError extends Error { code: string; peer?: Peer; statusCode?: number; }
export class PeerResponse { peer: Peer; statusCode: number; headers: IncomingHttpHeaders; body: Buffer; text(): string; json(): unknown; }
export class PeerPool {
  constructor(options?: { peers?: Peer[]; timeout?: number; retries?: number; failureThreshold?: number; cooldown?: number; maxResponseBytes?: number; maxSockets?: number; transport?: (request: TransportRequest) => Promise<TransportResponse> });
  readonly peers: Peer[];
  updatePeers(peers: Peer[]): this; rank(key: string): Peer[];
  stats(): Array<Peer & {
    failures: number; attempts: number; successes: number; inflight: number; circuit: string; probing: boolean;
    lastLatencyMs: number | null; ewmaLatencyMs: number | null; lastSuccessAt: number | null; lastFailureAt: number | null;
  }>;
  request(path: string, options?: PeerOptions): Promise<PeerResponse>;
  json(path: string, options?: PeerOptions): Promise<unknown>;
  broadcast(path: string, options?: PeerOptions & { concurrency?: number }): Promise<Array<{ peer: Peer; status: 'fulfilled'; value: PeerResponse } | { peer: Peer; status: 'rejected'; reason: unknown }>>;
  discover(provider: () => Peer[] | Promise<Peer[]>): Promise<Peer[]>;
  watch(provider: () => Peer[] | Promise<Peer[]>, options?: { interval?: number; onError?: (error: unknown) => void }): this;
  stopDiscovery(): this; close(): void;
}
