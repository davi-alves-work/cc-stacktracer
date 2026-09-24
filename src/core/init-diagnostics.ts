import type { ParsedStackTraceInit } from './config.schema.js';
import type { InternalFailureSink } from './safe-run.js';

const INTERNAL_FAILURE_MESSAGE = 'cc-stacktracer: internal failure — telemetry dropped, application unaffected';

/** O `logger` do cliente, se houver; senão o console, só com `debug: true`. Sem nenhum dos dois: silêncio. */
export function buildInternalFailureSink(config: ParsedStackTraceInit): InternalFailureSink | null {
  const logger = config.logger;
  if (logger?.warn !== undefined) {
    return (label, err) => {
      logger.warn?.({ label, error: err instanceof Error ? err.message : String(err) }, INTERNAL_FAILURE_MESSAGE);
    };
  }
  if (config.debug === true) {
    return (label, err) => {
      console.warn(`[${INTERNAL_FAILURE_MESSAGE}] (${label})`, err);
    };
  }
  return null;
}

function describeConfigError(err: unknown): string {
  const issues = (err as { issues?: unknown } | null)?.issues;
  if (Array.isArray(issues)) {
    return issues
      .map((issue: { path?: PropertyKey[]; message?: string }) => {
        const path = (issue.path ?? []).map(String).join('.');
        return `${path === '' ? '(root)' : path}: ${issue.message ?? 'invalid'}`;
      })
      .join('; ');
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Config inválida não derruba o boot — mas também não pode ser silenciosa, ou "a telemetria sumiu" não
 * teria explicação. Só caminho + mensagem do schema, nunca o valor: a `apiKey` passa por aqui.
 */
export function reportInvalidConfig(err: unknown): void {
  try {
    console.error(
      `[cc-stacktracer] init() ignored — invalid configuration, telemetry is OFF. ${describeConfigError(err)}. ` +
        'Run `npx cc-stacktracer doctor` to diagnose.',
    );
  } catch {
    // stderr indisponível: não há onde avisar
  }
}
