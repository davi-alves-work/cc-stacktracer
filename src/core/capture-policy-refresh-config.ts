import type { SdkLogger } from './config.types.js';

export const CAPTURE_POLICY_REFRESH_ENV = 'STACKTRACE_CAPTURE_POLICY_REFRESH_MS';
export const MIN_CAPTURE_POLICY_REFRESH_MS = 60_000;

const NORMALIZATION_WARNING = '[cc-stacktracer] capturePolicyRefreshMs below minimum. Using 60000ms.';
const warnedKeys = new Set<string>();

export type CapturePolicyRefreshSource = 'option' | 'env';

export type NormalizeCapturePolicyRefreshInput = {
  optionValue?: number | undefined;
  envValue?: string | undefined;
  logger?: SdkLogger | undefined;
  nodeEnv?: string | undefined;
};

function warnOnce(logger: SdkLogger | undefined, fields: Record<string, unknown>, message: string): void {
  const key = `${message}:${String(fields.source)}:${String(fields.inputMs)}`;
  if (warnedKeys.has(key)) {
    return;
  }
  warnedKeys.add(key);
  if (logger?.warn !== undefined) {
    logger.warn(fields, message);
    return;
  }
  console.warn(message, fields);
}

function parseEnvInteger(raw: string): number {
  const trimmed = raw.trim();
  if (!/^(0|[1-9]\d*)$/.test(trimmed)) {
    throw new Error(`${CAPTURE_POLICY_REFRESH_ENV} must be a non-negative integer in milliseconds`);
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${CAPTURE_POLICY_REFRESH_ENV} must be a safe integer in milliseconds`);
  }
  return value;
}

export function normalizeCapturePolicyRefreshMs(input: NormalizeCapturePolicyRefreshInput): number | undefined {
  const source: CapturePolicyRefreshSource | undefined =
    input.optionValue !== undefined ? 'option' : input.envValue !== undefined ? 'env' : undefined;
  if (source === undefined) {
    return undefined;
  }

  const rawValue = input.optionValue !== undefined ? input.optionValue : parseEnvInteger(input.envValue ?? '');
  if (!Number.isSafeInteger(rawValue) || rawValue < 0) {
    const key = source === 'env' ? CAPTURE_POLICY_REFRESH_ENV : 'capturePolicyRefreshMs';
    throw new Error(`${key} must be a non-negative integer in milliseconds`);
  }
  if (rawValue === 0 || rawValue >= MIN_CAPTURE_POLICY_REFRESH_MS) {
    return rawValue;
  }

  if (input.nodeEnv !== 'production') {
    warnOnce(
      input.logger,
      {
        configKey: source === 'env' ? CAPTURE_POLICY_REFRESH_ENV : 'capturePolicyRefreshMs',
        inputMs: rawValue,
        normalizedMs: MIN_CAPTURE_POLICY_REFRESH_MS,
        minMs: MIN_CAPTURE_POLICY_REFRESH_MS,
        source,
      },
      NORMALIZATION_WARNING,
    );
  }
  return MIN_CAPTURE_POLICY_REFRESH_MS;
}
