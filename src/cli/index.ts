#!/usr/bin/env node
/**
 * `npx cc-stacktracer doctor`
 *
 * Este arquivo é fino de propósito: liga o processo (argv, env, disco, rede, stdout, exit code) ao
 * `runDoctor`, que é onde mora o diagnóstico e o que os testes exercitam. Entrypoint com lógica é
 * entrypoint que ninguém testa.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderReport } from './report-text.js';
import { runDoctor, type DoctorEnv } from './run-doctor.js';
import type { PackageJsonLike } from './detect-stack.js';

const USAGE = [
  'Usage: npx cc-stacktracer <command> [options]',
  '',
  'Commands:',
  '  doctor        Diagnose the SDK installation in the current directory',
  '',
  'Options:',
  '  --json        Machine-readable output (for CI and coding assistants)',
  '  -h, --help    Show this help',
].join('\n');

/** Ausência de `package.json` não é erro: o doctor ainda checa config, rede e caminho de dados. */
function readPackageJson(cwd: string): PackageJsonLike | null {
  try {
    return JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as PackageJsonLike;
  } catch {
    return null;
  }
}

async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    console.log(USAGE);
    return args.length === 0 ? 1 : 0;
  }

  const command = args[0];
  if (command !== 'doctor') {
    console.error(`Unknown command: ${command}\n\n${USAGE}`);
    return 1;
  }

  const cwd = process.cwd();
  const env = process.env as DoctorEnv;
  const report = await runDoctor({
    cwd,
    env,
    packageJson: readPackageJson(cwd),
    fetchImpl: globalThis.fetch as never,
  });

  if (args.includes('--json')) {
    // Contrato de máquina: o `AGENTS.md` manda o assistente do cliente rodar e agir sobre isto.
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderReport(report, cwd, env.STACKTRACE_ENDPOINT).join('\n'));
  }

  return report.exitCode;
}

main(process.argv)
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    // Nunca stack trace crua no terminal de quem está instalando: ela não ajuda e assusta.
    console.error(`cc-stacktracer doctor failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
