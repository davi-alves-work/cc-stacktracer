import { getSdkRuntime } from './client-ref.js';
import {
  DEFAULT_HTTP_CLIENT_ERROR_STATUSES,
  DEFAULT_HTTP_SERVER_ERROR_STATUSES,
  parseHttpErrorStatuses,
  resolveHttpErrorStatuses,
  type HttpErrorStatusPredicate,
} from './http-error-statuses.js';

export const ERROR_TRACKING_ENV = 'STACKTRACE_ERROR_TRACKING_ENABLED';
export const HTTP_SERVER_ERROR_STATUSES_ENV = 'STACKTRACE_HTTP_SERVER_ERROR_STATUSES';
export const HTTP_CLIENT_ERROR_STATUSES_ENV = 'STACKTRACE_HTTP_CLIENT_ERROR_STATUSES';

export type ErrorTrackingConfig = {
  enabled: boolean;
  isServerErrorStatus: HttpErrorStatusPredicate;
  isClientErrorStatus: HttpErrorStatusPredicate;
};

const FALSY = new Set(['0', 'false', 'no', 'off']);

const DEFAULT_CONFIG: ErrorTrackingConfig = {
  enabled: true,
  isServerErrorStatus: parseHttpErrorStatuses(DEFAULT_HTTP_SERVER_ERROR_STATUSES),
  isClientErrorStatus: parseHttpErrorStatuses(DEFAULT_HTTP_CLIENT_ERROR_STATUSES),
};

/** Opcao do `init` > env > padrao (ligado; servidor e cliente em 500-599). */
export function resolveErrorTrackingConfig(params: {
  errorTracking?: boolean | undefined;
  httpServerErrorStatuses?: string | undefined;
  httpClientErrorStatuses?: string | undefined;
  env: Record<string, string | undefined>;
  warn: (message: string) => void;
}): ErrorTrackingConfig {
  const envEnabled = params.env[ERROR_TRACKING_ENV];
  const enabled = params.errorTracking ?? !(envEnabled !== undefined && FALSY.has(envEnabled.trim().toLowerCase()));
  return {
    enabled,
    isServerErrorStatus: resolveHttpErrorStatuses({
      option: params.httpServerErrorStatuses,
      envValue: params.env[HTTP_SERVER_ERROR_STATUSES_ENV],
      envName: HTTP_SERVER_ERROR_STATUSES_ENV,
      fallback: DEFAULT_HTTP_SERVER_ERROR_STATUSES,
      warn: params.warn,
    }),
    isClientErrorStatus: resolveHttpErrorStatuses({
      option: params.httpClientErrorStatuses,
      envValue: params.env[HTTP_CLIENT_ERROR_STATUSES_ENV],
      envName: HTTP_CLIENT_ERROR_STATUSES_ENV,
      fallback: DEFAULT_HTTP_CLIENT_ERROR_STATUSES,
      warn: params.warn,
    }),
  };
}

/** A config do `init` em vigor, ou o padrao quando nao ha init — testes e SDK desligado. */
export function getErrorTrackingConfig(): ErrorTrackingConfig {
  return getSdkRuntime().initConfig?.errorTracking ?? DEFAULT_CONFIG;
}
