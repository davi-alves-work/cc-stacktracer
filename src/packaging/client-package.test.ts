import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();

function readPackageJson(): {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  exports?: Record<string, unknown>;
  scripts?: Record<string, string>;
} {
  return JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as ReturnType<typeof readPackageJson>;
}

describe('client package manifest', () => {
  it('ships as a single client package without internal @cc-stacktracer dependencies', () => {
    const pkg = readPackageJson();
    const dependencies = pkg.dependencies ?? {};

    expect(Object.keys(dependencies).filter((name) => name.startsWith('@cc-stacktracer/'))).toEqual([]);
  });

  it('exposes generic HTTP and database integrations as subpaths of cc-stacktracer', () => {
    const pkg = readPackageJson();

    expect(pkg.exports).toMatchObject({
      './generic-http': expect.any(Object),
      './db-prisma': expect.any(Object),
      './db-lucid': expect.any(Object),
    });
  });

  it('marks framework dependencies as optional peers for client installation', () => {
    const pkg = readPackageJson();

    expect(pkg.peerDependencies).toMatchObject({
      fastify: expect.any(String),
      'fastify-plugin': expect.any(String),
      express: expect.any(String),
      '@adonisjs/core': expect.any(String),
      '@adonisjs/lucid': expect.any(String),
      '@prisma/client': expect.any(String),
    });
    expect(pkg.peerDependenciesMeta).toMatchObject({
      fastify: { optional: true },
      'fastify-plugin': { optional: true },
      express: { optional: true },
      '@adonisjs/core': { optional: true },
      '@adonisjs/lucid': { optional: true },
      '@prisma/client': { optional: true },
    });
  });

  it('provides client pack scripts for the single tgz flow', () => {
    const pkg = readPackageJson();

    expect(pkg.scripts).toMatchObject({
      'build:client': expect.any(String),
      'pack:client': expect.any(String),
      'pack:client:dry': expect.any(String),
    });
  });
});
