/**
 * Prova o caminho de dados ponta a ponta: monta, assina e envia telemetria de verdade.
 *
 * ## Por que log + span, e não um erro
 *
 * O plano original mandava enviar um erro sintético. Um erro cria um **grupo de erro permanente**
 * no `/errors` do cliente — a tela em que ele decide se acorda alguém de madrugada —, e ninguém
 * depois sabe se aquele grupo é real.
 *
 * Um log e um span exercitam exatamente o mesmo que um erro exercitaria: os dois endpoints
 * (`/v1/events` e `/v1/spans`), a mesma assinatura HMAC, a mesma resolução de API key e o mesmo
 * contrato v4. A cobertura é idêntica; o resíduo, não.
 *
 * ## Marcação
 *
 * Os dois envios levam `source: 'cc-stacktracer-doctor'` em `tags`/`attributes`, e a mensagem se
 * identifica. Quem olhar o painel sabe de onde veio, e consegue filtrar.
 */
import { randomUUID } from 'node:crypto';
import { signIngestionRequest } from '../core/transport/ingestion-signing.js';

/** Marca dos dois envios. Filtrável no dashboard e reconhecível pelo suporte. */
export const DOCTOR_SOURCE_TAG = 'cc-stacktracer-doctor';

export type ProbeInput = {
  endpoint: string;
  apiKey: string;
  serviceId: string;
};

export type ProbeStepName = 'events' | 'spans';

export type ProbeStepResult = {
  step: ProbeStepName;
  ok: boolean;
  status?: number;
  /** Corpo de erro da API, truncado — o dev precisa ver `code`, não um dump. */
  detail?: string;
};

export type ProbeResult = {
  ok: boolean;
  steps: ProbeStepResult[];
  /** Correlaciona os dois envios; o dev pode procurar por ele no dashboard. */
  traceId: string;
};

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text?: () => Promise<string> }>;

/** W3C: 32 hex para trace, 16 para span. `randomUUID` sem hífen dá 32 — o span usa a metade. */
function w3cIds(): { traceId: string; spanId: string } {
  const traceId = randomUUID().replace(/-/g, '');
  return { traceId, spanId: traceId.slice(0, 16) };
}

function eventsBody(input: ProbeInput, traceId: string, spanId: string, nowIso: string): string {
  return JSON.stringify({
    events: [
      {
        schema_version: 4,
        type: 'log',
        level: 'info',
        message: `cc-stacktracer doctor: connectivity probe (${DOCTOR_SOURCE_TAG})`,
        timestamp: nowIso,
        service_id: input.serviceId,
        trace: { trace_id: traceId, span_id: spanId },
        metadata: { tags: { source: DOCTOR_SOURCE_TAG } },
      },
    ],
  });
}

function spansBody(input: ProbeInput, traceId: string, spanId: string, nowIso: string): string {
  return JSON.stringify({
    spans: [
      {
        schema_version: 4,
        trace_id: traceId,
        span_id: spanId,
        name: 'cc-stacktracer.doctor.probe',
        span_type: 'business',
        status: 'ok',
        timestamp: nowIso,
        duration_us: 1000,
        service_id: input.serviceId,
        attributes: { source: DOCTOR_SOURCE_TAG },
      },
    ],
  });
}

async function post(
  fetchImpl: FetchLike,
  input: ProbeInput,
  path: string,
  body: string,
  step: ProbeStepName,
): Promise<ProbeStepResult> {
  const url = `${input.endpoint.replace(/\/$/, '')}${path}`;
  // O path assinado é o `pathname`, sem query — a query NÃO entra na canônica, nos dois lados.
  const headers = {
    'content-type': 'application/json',
    'x-api-key': input.apiKey,
    ...signIngestionRequest({ apiKey: input.apiKey, method: 'POST', path, serializedBody: body }),
  };

  try {
    const res = await fetchImpl(url, { method: 'POST', headers, body });
    if (res.ok) return { step, ok: true, status: res.status };
    const detail = res.text !== undefined ? (await res.text().catch(() => '')).slice(0, 300) : '';
    return { step, ok: false, status: res.status, ...(detail !== '' ? { detail } : {}) };
  } catch (err) {
    return { step, ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export async function probeIngest(input: ProbeInput, fetchImpl: FetchLike): Promise<ProbeResult> {
  const { traceId, spanId } = w3cIds();
  const nowIso = new Date().toISOString();

  // Sequencial, não em paralelo: se o primeiro falha por credencial, o segundo falharia pelo mesmo
  // motivo e o dev leria dois erros para um problema só.
  const events = await post(fetchImpl, input, '/v1/events', eventsBody(input, traceId, spanId, nowIso), 'events');
  if (!events.ok) {
    return { ok: false, steps: [events], traceId };
  }

  const spans = await post(fetchImpl, input, '/v1/spans', spansBody(input, traceId, spanId, nowIso), 'spans');
  return { ok: spans.ok, steps: [events, spans], traceId };
}
