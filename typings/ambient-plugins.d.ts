/** Optional workspace packages — resolved at runtime after `npm install` in the monorepo. */
declare module '@cc-stacktracer/http-fastify' {
  import type { FastifyPluginAsync } from 'fastify';
  const plugin: FastifyPluginAsync;
  export default plugin;
  export const stackTracePlugin: {
    name: string;
    type: 'http' | 'db' | 'runtime' | 'custom';
    init: (ctx: unknown) => void | Promise<void>;
  };
}

declare module '@cc-stacktracer/db-prisma' {
  export function createStackTracePrismaQueryExtension(): unknown;
  export function createPrismaStackTracePlugin(prisma: unknown): {
    name: string;
    type: 'http' | 'db' | 'runtime' | 'custom';
    init: (ctx: unknown) => void | Promise<void>;
  };
}

declare module '@cc-stacktracer/db-lucid' {
  export function createLucidStackTracePlugin(db: unknown): {
    name: string;
    type: 'http' | 'db' | 'runtime' | 'custom';
    init: (ctx: unknown) => void | Promise<void>;
  };
}
