import { z } from 'zod';
import { INSTRUMENTATION_CHECKS, INSTRUMENTATION_SEVERITIES } from './instrumentation-checks.js';

/**
 * Event types (verbs) represent the kind of telemetry being evaluated (log, error, HTTP request, etc.).
 * Note: `metric` was removed in 2026-04 — performance events now evaluate as `log`.
 * Legacy payloads containing `metric` (in `defaultCapture` or rule `match.eventType`) are silently dropped.
 */
export const captureEventTypeSchema = z.enum(['log', 'error', 'http', 'span']);
export type CaptureEventType = z.infer<typeof captureEventTypeSchema>;

/** Max rules per policy (dashboard/API) to bound hot-path work. */
export const CAPTURE_POLICY_MAX_RULES = 64;
export const CAPTURE_POLICY_MAX_ENDPOINT_LEN = 2048;

const captureRuleMatchSchema = z
  .object({
    eventType: captureEventTypeSchema.optional(),
    endpoint: z.string().max(CAPTURE_POLICY_MAX_ENDPOINT_LEN).optional(),
    status_code: z.number().int().min(100).max(599).optional(),
    service_name: z.string().max(512).optional(),
    /** Keep the span only when its duration_ms is >= this threshold (e.g. force-capture slow spans). */
    minDurationMs: z.number().int().min(0).optional(),
  })
  .strict();

const captureRuleActionSchema = z
  .object({
    /** When false after a match, the event is dropped before further processing. */
    capture: z.boolean().optional(),
    /**
     * When true after a match, capture is forced (e.g. critical errors). Stops rule evaluation.
     */
    forceCapture: z.boolean().optional(),
    /** Probability in [0,1] to keep the event when matched; uses `random() > sampleRate` → drop. */
    sampleRate: z.number().min(0).max(1).optional(),
  })
  .strict();

export const captureRuleSchema = z
  .object({
    match: captureRuleMatchSchema,
    action: captureRuleActionSchema,
  })
  .strict();

export type CaptureRule = z.infer<typeof captureRuleSchema>;

// Not strict: unknown keys (e.g. legacy `metric`) are silently stripped by Zod default strip mode.
const defaultCapturePartialSchema = z.object({
  log: z.boolean().optional(),
  error: z.boolean().optional(),
  http: z.boolean().optional(),
  span: z.boolean().optional(),
});

/** V2 wire shape stored in JSONB (and returned by APIs). */
/**
 * Avisos de instrumentacao que o servidor anexa a politica, para o SDK logar no boot.
 *
 * **A lista de codigos nunca e reescrita aqui** — vem de `INSTRUMENTATION_CHECKS`, o mesmo contrato
 * que o audit usa para EMITIR. Escreve-la a mao foi o defeito C1: o enum nascia com 7 codigos
 * enquanto o audit emitia 10, e `z.array()` e tudo-ou-nada — um unico codigo fora do enum reprova o
 * array INTEIRO. Somando ao `safeParse` silencioso do lado do SDK, um serviço com
 * `subtenant_cardinality` apagaria TODOS os avisos daquele ciclo, sem erro e sem sintoma.
 */
export const capturePolicyNoticeSchema = z
  .object({
    code: z.enum(INSTRUMENTATION_CHECKS),
    severity: z.enum(INSTRUMENTATION_SEVERITIES),
    params: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
  })
  .strict();

export type CapturePolicyNotice = z.infer<typeof capturePolicyNoticeSchema>;

/** Teto de avisos por resposta: o log de boot e um bloco, nao um relatorio. */
export const CAPTURE_POLICY_MAX_NOTICES = 20;

export const capturePolicyV2WireSchema = z
  .object({
    enabled: z.boolean(),
    defaultCapture: defaultCapturePartialSchema.optional(),
    rules: z.array(captureRuleSchema).max(CAPTURE_POLICY_MAX_RULES).optional(),
    /** Aditivo e opcional: SDK antigo ignora, servidor novo nao quebra cliente velho. */
    notices: z.array(capturePolicyNoticeSchema).max(CAPTURE_POLICY_MAX_NOTICES).optional(),
  })
  .strict();

export type CapturePolicyV2Wire = z.infer<typeof capturePolicyV2WireSchema>;

/** Legacy flat policy (existing rows). */
export const capturePolicyLegacyWireSchema = z
  .object({
    captureErrors: z.boolean(),
    captureLogs: z.boolean(),
    captureHttpRequests: z.boolean(),
    captureMetrics: z.boolean().optional(),
    logSampleRate: z.number().min(0).max(1).optional(),
  })
  .strict();

export type CapturePolicyLegacyWire = z.infer<typeof capturePolicyLegacyWireSchema>;

export type CaptureEvaluationContext = {
  service_name: string;
  endpoint?: string | undefined;
  status_code?: number | undefined;
  /** Critical override: always capture when true (evaluated before rules). */
  critical?: boolean | undefined;
  /** Span duration in milliseconds — used by minDurationMs rule matching. */
  duration_ms?: number | undefined;
};

/** Per-type defaults; omitted keys in wire mean permissive (true). */
export type CaptureDefaultMap = Record<CaptureEventType, boolean>;

export type CompiledCaptureRule = {
  matchEventType: CaptureEventType | undefined;
  matchEndpoint: string | undefined;
  matchStatusCode: number | undefined;
  matchServiceName: string | undefined;
  matchMinDurationMs: number | undefined;
  action: {
    forceCapture?: boolean;
    capture?: boolean;
    sampleRate?: number;
  };
};

export type CompiledCapturePolicy = {
  enabled: boolean;
  defaults: CaptureDefaultMap;
  rules: CompiledCaptureRule[];
};

const PERMISSIVE_DEFAULTS: CaptureDefaultMap = {
  log: true,
  error: true,
  http: true,
  span: true,
};

function mergeDefaults(partial?: Partial<Record<CaptureEventType, boolean | undefined>>): CaptureDefaultMap {
  return {
    log: partial?.log ?? PERMISSIVE_DEFAULTS.log,
    error: partial?.error ?? PERMISSIVE_DEFAULTS.error,
    http: partial?.http ?? PERMISSIVE_DEFAULTS.http,
    span: partial?.span ?? PERMISSIVE_DEFAULTS.span,
  };
}

function legacyToV2Wire(legacy: CapturePolicyLegacyWire): CapturePolicyV2Wire {
  const rules: CaptureRule[] = [];
  if (legacy.logSampleRate !== undefined && legacy.logSampleRate < 1) {
    rules.push({
      match: { eventType: 'log' },
      action: { sampleRate: legacy.logSampleRate },
    });
  }
  return {
    enabled: true,
    defaultCapture: {
      log: legacy.captureLogs,
      error: legacy.captureErrors,
      http: legacy.captureHttpRequests,
      // legacy.captureMetrics is intentionally not mapped — metric flag removed.
      span: legacy.captureLogs,
    },
    rules: rules.length > 0 ? rules : undefined,
  };
}

function compileRule(rule: CaptureRule): CompiledCaptureRule {
  const m = rule.match;
  const action: CompiledCaptureRule['action'] = {};
  if (rule.action.forceCapture !== undefined) action.forceCapture = rule.action.forceCapture;
  if (rule.action.capture !== undefined) action.capture = rule.action.capture;
  if (rule.action.sampleRate !== undefined) action.sampleRate = rule.action.sampleRate;

  return {
    matchEventType: m.eventType,
    matchEndpoint: m.endpoint,
    matchStatusCode: m.status_code,
    matchServiceName: m.service_name,
    matchMinDurationMs: m.minDurationMs,
    action,
  };
}

/**
 * Compiles a validated V2 wire policy for fast synchronous evaluation.
 */
export function compileCapturePolicy(wire: CapturePolicyV2Wire): CompiledCapturePolicy {
  const defaults = mergeDefaults(wire.defaultCapture);
  const rules = (wire.rules ?? []).map(compileRule);
  return {
    enabled: wire.enabled,
    defaults,
    rules,
  };
}

export const DEFAULT_COMPILED_CAPTURE_POLICY: CompiledCapturePolicy = compileCapturePolicy({
  enabled: true,
  defaultCapture: {},
});

function ruleMatches(rule: CompiledCaptureRule, eventType: CaptureEventType, ctx: CaptureEvaluationContext): boolean {
  if (rule.matchEventType !== undefined && rule.matchEventType !== eventType) {
    return false;
  }
  if (rule.matchEndpoint !== undefined) {
    if (ctx.endpoint === undefined || ctx.endpoint !== rule.matchEndpoint) {
      return false;
    }
  }
  if (rule.matchStatusCode !== undefined) {
    if (ctx.status_code === undefined || ctx.status_code !== rule.matchStatusCode) {
      return false;
    }
  }
  if (rule.matchServiceName !== undefined) {
    if (ctx.service_name !== rule.matchServiceName) {
      return false;
    }
  }
  if (rule.matchMinDurationMs !== undefined) {
    if (ctx.duration_ms === undefined || ctx.duration_ms < rule.matchMinDurationMs) {
      return false;
    }
  }
  return true;
}

export type EvaluateCaptureOptions = {
  random?: () => number;
  /** When false, skip critical short-circuit (tests / special callers). */
  respectCritical?: boolean;
};

/**
 * Synchronous capture decision. No I/O. Order: master switch → critical → rules → defaults.
 *
 * Educational notes (product / ops):
 * - **Sampling** reduces volume of captured telemetry while keeping approximate statistical representativeness.
 * - **Event types** are the verbs of the pipeline (`log`, `error`, `http`, `span`).
 * - **`capture: false`** on a matching rule means the event is fully discarded before further processing.
 * - **`forceCapture: true`** stops rule evaluation and guarantees capture (e.g. critical incidents).
 *
 * Rule actions after a match: `forceCapture` → `capture === false` → `sampleRate` (if present).
 */
export function evaluateCapture(
  compiled: CompiledCapturePolicy,
  eventType: CaptureEventType,
  context: CaptureEvaluationContext,
  options?: EvaluateCaptureOptions,
): boolean {
  if (!compiled.enabled) {
    return false;
  }
  const respectCritical = options?.respectCritical !== false;
  if (respectCritical && context.critical === true) {
    return true;
  }
  const rng = options?.random ?? Math.random;
  for (const rule of compiled.rules) {
    if (!ruleMatches(rule, eventType, context)) {
      continue;
    }
    const a = rule.action;
    if (a.forceCapture === true) {
      return true;
    }
    if (a.capture === false) {
      return false;
    }
    if (a.sampleRate !== undefined) {
      return !(rng() > a.sampleRate);
    }
    return true;
  }
  const d = compiled.defaults[eventType];
  return d !== false;
}

export type CaptureEvaluationDiagnostics = {
  allowed: boolean;
  phase: 'disabled' | 'critical' | 'rule' | 'default';
  /** Index into compiled.rules when phase is `rule`. */
  ruleIndex: number | null;
  detail: string;
};

/**
 * Same decision as {@link evaluateCapture}, plus which phase/rule applied (for dashboards / simulators).
 */
export function evaluateCaptureDiagnostics(
  compiled: CompiledCapturePolicy,
  eventType: CaptureEventType,
  context: CaptureEvaluationContext,
  options?: EvaluateCaptureOptions,
): CaptureEvaluationDiagnostics {
  if (!compiled.enabled) {
    return {
      allowed: false,
      phase: 'disabled',
      ruleIndex: null,
      detail: 'Master switch (enabled) is off',
    };
  }
  const respectCritical = options?.respectCritical !== false;
  if (respectCritical && context.critical === true) {
    return {
      allowed: true,
      phase: 'critical',
      ruleIndex: null,
      detail: 'Critical context bypasses rules and defaults',
    };
  }
  const rng = options?.random ?? Math.random;
  for (let i = 0; i < compiled.rules.length; i++) {
    const rule = compiled.rules[i]!;
    if (!ruleMatches(rule, eventType, context)) {
      continue;
    }
    const a = rule.action;
    if (a.forceCapture === true) {
      return {
        allowed: true,
        phase: 'rule',
        ruleIndex: i,
        detail: 'Matched rule: forceCapture',
      };
    }
    if (a.capture === false) {
      return {
        allowed: false,
        phase: 'rule',
        ruleIndex: i,
        detail: 'Matched rule: capture false (drop)',
      };
    }
    if (a.sampleRate !== undefined) {
      const kept = !(rng() > a.sampleRate);
      return {
        allowed: kept,
        phase: 'rule',
        ruleIndex: i,
        detail: kept
          ? `Matched rule: sample kept (sampleRate=${a.sampleRate})`
          : `Matched rule: sample dropped (sampleRate=${a.sampleRate})`,
      };
    }
    return {
      allowed: true,
      phase: 'rule',
      ruleIndex: i,
      detail: 'Matched rule: capture (implicit allow)',
    };
  }
  const d = compiled.defaults[eventType];
  const allowed = d !== false;
  return {
    allowed,
    phase: 'default',
    ruleIndex: null,
    detail: allowed ? `Default for ${eventType}: permissive or true` : `Default for ${eventType}: false`,
  };
}

/** Map SDK / span row to event type for evaluation (http spans use `http`; others use `span`). */
export function spanRowToCaptureEventType(spanType: string | null | undefined): CaptureEventType {
  return (spanType ?? '').toLowerCase() === 'http' ? 'http' : 'span';
}

/**
 * Strips rules with `match.eventType === 'metric'` from a raw V2 wire object before parsing.
 * Needed for backward compat: policies saved before metric removal may have such rules.
 */
function dropLegacyMetricRules(raw: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(raw.rules)) return raw;
  const filtered = (raw.rules as unknown[]).filter((r) => {
    if (typeof r !== 'object' || r === null) return true;
    const match = (r as Record<string, unknown>).match;
    if (typeof match === 'object' && match !== null) {
      if ((match as Record<string, unknown>).eventType === 'metric') return false;
    }
    return true;
  });
  return { ...raw, rules: filtered };
}

/**
 * Strict compile for hot-reload paths: returns `null` if the value is not a valid V2 or legacy wire.
 * Unlike {@link parseAndCompileCapturePolicy}, invalid input does **not** fall back to the default permissive policy.
 */
export function compileCapturePolicyFromRawOrNull(value: unknown): CompiledCapturePolicy | null {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const o = value as Record<string, unknown>;
  if (typeof o.enabled === 'boolean') {
    const narrowed = dropLegacyMetricRules({
      enabled: o.enabled as boolean,
      ...(o.defaultCapture !== undefined ? { defaultCapture: o.defaultCapture } : {}),
      ...(o.rules !== undefined ? { rules: o.rules } : {}),
    });
    const v2 = capturePolicyV2WireSchema.safeParse(narrowed);
    if (!v2.success) {
      return null;
    }
    return compileCapturePolicy(v2.data);
  }
  const leg = capturePolicyLegacyWireSchema.safeParse(value);
  if (!leg.success) {
    return null;
  }
  return compileCapturePolicy(legacyToV2Wire(leg.data));
}

/**
 * Parse JSONB / API payload into a compiled policy. Supports legacy flat shape and V2 `{ enabled, defaultCapture, rules }`.
 */
export function parseAndCompileCapturePolicy(value: unknown): CompiledCapturePolicy {
  if (value === null || value === undefined) {
    return DEFAULT_COMPILED_CAPTURE_POLICY;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return DEFAULT_COMPILED_CAPTURE_POLICY;
  }
  const o = value as Record<string, unknown>;

  if (typeof o.enabled === 'boolean') {
    const narrowed = dropLegacyMetricRules({
      enabled: o.enabled as boolean,
      ...(o.defaultCapture !== undefined ? { defaultCapture: o.defaultCapture } : {}),
      ...(o.rules !== undefined ? { rules: o.rules } : {}),
    });
    const v2 = capturePolicyV2WireSchema.safeParse(narrowed);
    if (v2.success) {
      return compileCapturePolicy(v2.data);
    }
    return DEFAULT_COMPILED_CAPTURE_POLICY;
  }

  const leg = capturePolicyLegacyWireSchema.safeParse(value);
  if (leg.success) {
    return compileCapturePolicy(legacyToV2Wire(leg.data));
  }

  return DEFAULT_COMPILED_CAPTURE_POLICY;
}

/** Serialize V2 wire for persistence (optional helper). */
export function compiledToV2Wire(compiled: CompiledCapturePolicy): CapturePolicyV2Wire {
  return {
    enabled: compiled.enabled,
    defaultCapture: {
      log: compiled.defaults.log,
      error: compiled.defaults.error,
      http: compiled.defaults.http,
      span: compiled.defaults.span,
    },
    rules: compiled.rules.map((r) => ({
      match: {
        ...(r.matchEventType !== undefined ? { eventType: r.matchEventType } : {}),
        ...(r.matchEndpoint !== undefined ? { endpoint: r.matchEndpoint } : {}),
        ...(r.matchStatusCode !== undefined ? { status_code: r.matchStatusCode } : {}),
        ...(r.matchServiceName !== undefined ? { service_name: r.matchServiceName } : {}),
        ...(r.matchMinDurationMs !== undefined ? { minDurationMs: r.matchMinDurationMs } : {}),
      },
      action: { ...r.action },
    })),
  };
}
