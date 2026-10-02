import type { Middleware, Plugin } from '../index.js';
export function jsonBody(options?: { limit?: number }): Middleware;
export function requestContext(options?: { service?: string; requestIdHeader?: string }): Middleware;
export function health(options?: { ready?: () => boolean | Promise<boolean>; livePath?: string; readyPath?: string }): Plugin;
