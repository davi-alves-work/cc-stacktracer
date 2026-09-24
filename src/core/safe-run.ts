import { isSdkDisabledByEnv, refreshKillSwitch } from './kill-switch.js';

/** Destino das falhas internas: o `logger` do cliente, ou o console com `debug: true`. `null` = silêncio. */
export type InternalFailureSink = (label: string, err: unknown) => void;

type NotThenable<T> = T extends PromiseLike<unknown> ? never : T;

export const FUSE_THRESHOLD = 100;
const FUSE_WINDOW_MS = 60_000;
const REPORT_INTERVAL_MS = 60_000;

let sink: InternalFailureSink | null = null;
let reporting = false;
const lastReportAt = new Map<string, number>();
let windowStart = 0;
let windowCount = 0;
let fuseTripped = false;

const ignore = (): void => undefined;

export function setInternalFailureSink(next: InternalFailureSink | null): void {
  sink = next;
}

/** Falso com o kill switch ligado ou depois que o fusível desarmou: toda instrumentação vira pass-through. */
export function isTelemetryActive(): boolean {
  return !fuseTripped && !isSdkDisabledByEnv();
}

function countTowardsFuse(now: number): void {
  if (now - windowStart > FUSE_WINDOW_MS) {
    windowStart = now;
    windowCount = 0;
  }
  windowCount += 1;
  if (fuseTripped || windowCount < FUSE_THRESHOLD) {
    return;
  }
  fuseTripped = true;
  try {
    console.warn(
      `[cc-stacktracer] ${FUSE_THRESHOLD} internal failures within ${FUSE_WINDOW_MS / 1000}s — telemetry is disabled until the process restarts. Your application is not affected.`,
    );
  } catch {
    // stdout indisponível: não há onde avisar
  }
}

/**
 * Destino único de toda falha que o SDK engole. Descartar a telemetria É a recuperação; este registro
 * é o que impede o catch de ser mudo — conta para o fusível e chega ao sink quando o cliente pediu.
 */
export function reportInternalFailure(label: string, err: unknown): void {
  const now = Date.now();
  countTowardsFuse(now);
  if (sink === null || reporting) {
    return;
  }
  const last = lastReportAt.get(label);
  if (last !== undefined && now - last < REPORT_INTERVAL_MS) {
    return;
  }
  lastReportAt.set(label, now);
  reporting = true;
  try {
    sink(label, err);
  } catch {
    // o sink é código do cliente (logger); não há mais para onde reportar
  } finally {
    reporting = false;
  }
}

/**
 * Roda código de TELEMETRIA. Nunca envolva a operação do cliente com isto: o erro dela sumiria.
 * O tipo recusa função async — para ela, use {@link safeRunAsync} ou {@link runDetached}.
 */
export function safeRun<T>(label: string, fn: () => NotThenable<T>): T | undefined {
  try {
    return fn();
  } catch (err) {
    reportInternalFailure(label, err);
    return undefined;
  }
}

export async function safeRunAsync<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    reportInternalFailure(label, err);
    return undefined;
  }
}

/** A única forma permitida de soltar uma promise que ninguém aguarda — o lint barra `void promise`. */
export function runDetached(label: string, fn: () => Promise<unknown>): void {
  safeRunAsync(label, fn).then(ignore, ignore);
}

export function resetFailOpenState(): void {
  sink = null;
  reporting = false;
  lastReportAt.clear();
  windowStart = 0;
  windowCount = 0;
  fuseTripped = false;
  refreshKillSwitch();
}
