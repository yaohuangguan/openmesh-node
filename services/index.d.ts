import type { AddressInfo } from 'node:net';
import type { Plugin } from '../index.js';

export type MaybePromise<T> = T | Promise<T>;
export interface Instance { service: string; id: string; url: string; ttl: number; expiresAt: number; metadata: Readonly<Record<string, unknown>>; }
export interface ServiceSnapshot { service: string; revision?: number; instances: readonly Instance[]; }
export interface Lease extends Instance { leaseId: string; }
export interface ConfigSnapshot { namespace: string; epoch: string; revision: number; values: Readonly<Record<string, unknown>>; }
export interface RegistrationOptions { id: string; url: string; ttl?: number; metadata?: Record<string, unknown>; onError?: (error: Error) => void; }

export class RegistryAdapter {
  register(service: string, id: string, options: Omit<RegistrationOptions, 'id' | 'onError'>): MaybePromise<Lease>;
  renew(service: string, id: string, leaseId: string): MaybePromise<Lease>;
  deregister(service: string, id: string, leaseId: string): MaybePromise<void>;
  list(service: string): MaybePromise<Instance[]>;
  snapshot(service: string): MaybePromise<ServiceSnapshot>;
  subscribe(service: string, listener: () => void): MaybePromise<() => void>;
  close(): MaybePromise<void>;
}
export class ConfigAdapter {
  snapshot(namespace: string): MaybePromise<ConfigSnapshot>;
  replace(namespace: string, values: Record<string, unknown>, expectedRevision: number, expectedEpoch: string): MaybePromise<ConfigSnapshot>;
  subscribe(namespace: string, listener: (snapshot?: ConfigSnapshot) => void): MaybePromise<() => void>;
  close(): MaybePromise<void>;
}
export class ServiceRegistry extends RegistryAdapter {
  constructor(options?: { maxInstances?: number; sweepInterval?: number; now?: () => number });
  register(service: string, id: string, options: Omit<RegistrationOptions, 'id' | 'onError'>): Lease;
  renew(service: string, id: string, leaseId: string): Lease;
  deregister(service: string, id: string, leaseId: string): void;
  list(service: string): Instance[]; snapshot(service: string): ServiceSnapshot; sweep(): void;
  subscribe(service: string, listener: (change?: { service: string; reason: string; revision: number }) => void): () => void;
  close(): void;
}
export class ConfigStore extends ConfigAdapter {
  constructor(options?: { maxNamespaces?: number; maxBytes?: number });
  snapshot(namespace: string): ConfigSnapshot;
  replace(namespace: string, values: Record<string, unknown>, expectedRevision: number, expectedEpoch: string): ConfigSnapshot;
  subscribe(namespace: string, listener: (snapshot?: ConfigSnapshot) => void): () => void;
  close(): void;
}
export function controlPlane(options: { token: string; registry?: RegistryAdapter; config?: ConfigAdapter; prefix?: string }): Plugin;

export interface WatchOptions {
  interval?: number;
  reconnectDelay?: number;
  transport?: 'stream' | 'poll';
  validate?: (values: Readonly<Record<string, unknown>>) => void;
  onUpdate?: (current: ConfigSnapshot, previous: ConfigSnapshot) => void;
  onError?: (error: Error) => void;
}
export interface ServiceWatchOptions {
  interval?: number;
  reconnectDelay?: number;
  transport?: 'stream' | 'poll';
  onUpdate?: (current: readonly Instance[], previous: readonly Instance[]) => void;
  onError?: (error: Error) => void;
}
export class Registration {
  readonly record: Lease; readonly healthy: boolean; readonly lastError: Error | null;
  stop(): Promise<void>;
}
export class ConfigWatcher {
  readonly snapshot: ConfigSnapshot; readonly lastError: Error | null;
  get(key: string, fallback?: unknown): unknown; stop(): void;
}
export class ServiceWatcher {
  readonly service: string;
  readonly instances: readonly Instance[];
  readonly lastError: Error | null;
  stop(): void;
}
export class ControlClient {
  constructor(options: { url: string; token: string; timeout?: number });
  register(service: string, options: RegistrationOptions): Promise<Registration>;
  discover(service: string, options?: { signal?: AbortSignal }): Promise<Instance[]>;
  getConfig(namespace: string, options?: { signal?: AbortSignal }): Promise<ConfigSnapshot>;
  setConfig(namespace: string, values: Record<string, unknown>, options: { expectedRevision: number; expectedEpoch: string; signal?: AbortSignal }): Promise<ConfigSnapshot>;
  watchConfig(namespace: string, options?: WatchOptions): Promise<ConfigWatcher>;
  watchService(service: string, options?: ServiceWatchOptions): Promise<ServiceWatcher>;
  close(): Promise<void>;
}
export function serviceRegistration(options: Omit<RegistrationOptions, 'url'> & {
  client: ControlClient; service: string; url: string | ((address: AddressInfo | string | null) => string);
}): Plugin;

declare module '../index.js' { interface OpenMesh { registration?: Registration | null; } }
