import type { Plugin } from '../core/app.js';
import { definePlugin } from '../core/app.js';

export type DatabaseMaybePromise<T> = T | Promise<T>;
export type DatabaseState = 'idle' | 'connecting' | 'ready' | 'closing' | 'closed' | 'failed';

export interface DatabaseOptions<Client, TransactionClient = Client> {
  name?: string;
  connect?: (client: Client) => DatabaseMaybePromise<void>;
  disconnect?: (client: Client) => DatabaseMaybePromise<void>;
  ping?: (client: Client) => DatabaseMaybePromise<boolean | void>;
  transaction?: <T>(
    client: Client,
    work: (transaction: TransactionClient) => DatabaseMaybePromise<T>
  ) => Promise<T>;
}

export interface DatabaseResource<Client, TransactionClient = Client> extends Plugin {
  readonly client: Client;
  readonly name: string;
  readonly state: DatabaseState;
  readonly ready: boolean;
  readonly supportsTransactions: boolean;
  healthy(): Promise<boolean>;
  transaction<T>(
    work: (transaction: TransactionClient) => DatabaseMaybePromise<T>
  ): Promise<T>;
}

const DATABASE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function assertCallback(value: unknown, label: string): void {
  if (value !== undefined && typeof value !== 'function') {
    throw new TypeError(label + ' must be a function');
  }
}

export function database<Client, TransactionClient = Client>(
  client: Client,
  options: DatabaseOptions<Client, TransactionClient> = {}
): DatabaseResource<Client, TransactionClient> {
  if (
    client === null ||
    (typeof client !== 'object' && typeof client !== 'function')
  ) {
    throw new TypeError('database client must be an object');
  }
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('database options must be an object');
  }

  const name = options.name ?? 'default';
  if (typeof name !== 'string' || !DATABASE_NAME.test(name)) {
    throw new TypeError('database name must be 1..128 letters, numbers, dot, underscore or dash');
  }

  assertCallback(options.connect, 'database connect');
  assertCallback(options.disconnect, 'database disconnect');
  assertCallback(options.ping, 'database ping');
  assertCallback(options.transaction, 'database transaction');

  let state: DatabaseState = 'idle';
  let closePromise: Promise<void> | null = null;

  const close = async (): Promise<void> => {
    if (closePromise) return closePromise;
    if (state === 'closed') return;

    closePromise = (async () => {
      const shouldDisconnect = state !== 'idle';
      state = 'closing';
      try {
        if (shouldDisconnect && options.disconnect) {
          await options.disconnect(client);
        }
        state = 'closed';
      } catch (error) {
        state = 'failed';
        throw error;
      }
    })();

    return closePromise;
  };

  const plugin = definePlugin(async app => {
    if (state !== 'idle') {
      throw new Error('Database resource ' + name + ' has already been started');
    }

    app.onClose(close);
    state = 'connecting';

    try {
      if (options.connect) await options.connect(client);
      state = 'ready';
    } catch (error) {
      state = 'failed';
      throw error;
    }
  }, {
    name: 'database:' + name,
    global: true
  }) as DatabaseResource<Client, TransactionClient>;

  Object.defineProperties(plugin, {
    client: {
      value: client,
      enumerable: true
    },
    name: {
      value: name,
      enumerable: true
    },
    state: {
      get: () => state,
      enumerable: true
    },
    ready: {
      get: () => state === 'ready',
      enumerable: true
    },
    supportsTransactions: {
      value: typeof options.transaction === 'function',
      enumerable: true
    },
    healthy: {
      value: async (): Promise<boolean> => {
        if (state !== 'ready') return false;
        if (!options.ping) return true;
        try {
          return (await options.ping(client)) !== false;
        } catch {
          return false;
        }
      },
      enumerable: true
    },
    transaction: {
      value: async <T>(
        work: (transaction: TransactionClient) => DatabaseMaybePromise<T>
      ): Promise<T> => {
        if (typeof work !== 'function') throw new TypeError('database transaction work must be a function');
        if (state !== 'ready') throw new Error('Database resource ' + name + ' is not ready');
        if (!options.transaction) {
          throw new Error('Database resource ' + name + ' has no transaction adapter');
        }
        return options.transaction(client, work);
      },
      enumerable: true
    }
  });

  return plugin;
}
