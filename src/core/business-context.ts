import { AsyncLocalStorage } from 'node:async_hooks';

/** Business domain context merged into event `context.business` (maps to `metadata.business` after normalization). */
export type BusinessContext = {
  entity: string;
  operation: string;
  fields_changed?: string[];
};

const storage = new AsyncLocalStorage<BusinessContext>();

export function getBusinessContext(): BusinessContext | undefined {
  return storage.getStore();
}

export function withBusinessContext<T>(ctx: BusinessContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function withBusinessContextAsync<T>(ctx: BusinessContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(ctx, fn);
}
