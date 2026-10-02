import type { AddressInfo } from 'node:net';
import type { Plugin } from '../index.js';
export interface Instance { service: string; id: string; url: string; ttl: number; expiresAt: number; metadata: Readonly<Record<string, unknown>>; }
export interface Lease extends Instance { leaseId: string; }
export interface ConfigSnapshot { namespace: string; epoch: string; revision: number; values: Readonly<Record<string, unknown>>; }
export interface RegistrationOptions { id: string; url: string; ttl?: number; metadata?: Record<string, unknown>; onError?: (error: Error) => void; }
export class ServiceRegistry {
  constructor(options?: { maxInstances?: number; sweepInterval?: number; now?: () => number });
  register(service: string, id: string, options: Omit<RegistrationOptions, 'id' | 'onError'>): Lease;
  renew(service: string, id: string, leaseId: string): Lease;
  deregister(service: string, id: string, leaseId: string): void;
  list(service: string): Instance[]; sweep(): void; close(): void;
}
export class ConfigStore {
  constructor(options?: { maxNamespaces?: number; maxBytes?: number });
  snapshot(namespace: string): ConfigSnapshot;
  replace(namespace: string, values: Record<string, unknown>, expectedRevision: number, expectedEpoch: string): ConfigSnapshot;
}
export function controlPlane(options: { token: string; registry?: ServiceRegistry; config?: ConfigStore; prefix?: string }): Plugin;
export interface WatchOptions { interval?: number; validate?: (values: Readonly<Record<string, unknown>>) => void; onUpdate?: (current: ConfigSnapshot, previous: ConfigSnapshot) => void; onError?: (error: Error) => void; }
export class Registration {
  readonly record: Lease; readonly healthy: boolean; readonly lastError: Error | null;
  stop(): Promise<void>;
}
export class ConfigWatcher {
  readonly snapshot: ConfigSnapshot; readonly lastError: Error | null;
  get(key: string, fallback?: unknown): unknown; stop(): void;
}
export class ControlClient {
  constructor(options: { url: string; token: string; timeout?: number });
  register(service: string, options: RegistrationOptions): Promise<Registration>;
  discover(service: string, options?: { signal?: AbortSignal }): Promise<Instance[]>;
  getConfig(namespace: string, options?: { signal?: AbortSignal }): Promise<ConfigSnapshot>;
  setConfig(namespace: string, values: Record<string, unknown>, options: { expectedRevision: number; expectedEpoch: string; signal?: AbortSignal }): Promise<ConfigSnapshot>;
  watchConfig(namespace: string, options?: WatchOptions): Promise<ConfigWatcher>;
  close(): Promise<void>;
}
export function serviceRegistration(options: Omit<RegistrationOptions, 'url'> & {
  client: ControlClient; service: string; url: string | ((address: AddressInfo | string | null) => string);
}): Plugin;
declare module '../index.js' { interface OpenMesh { registration?: Registration | null; } }
