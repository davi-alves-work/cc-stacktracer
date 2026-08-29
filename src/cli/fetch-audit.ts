/**
 * Busca os findings de instrumentação no servidor.
 *
 * **As regras não são replicadas aqui.** Uma regra, um lugar: quem decide severidade, score e guia é
 * `buildInstrumentationAudit`, no servidor. O CLI recebe `check` + `params` e renderiza — se
 * duplicasse a heurística, a tela e o terminal passariam a discordar sobre o mesmo serviço, que é
 * exatamente o problema de confiança que esta ferramenta existe para resolver.
 */
import { signIngestionRequest } from '../core/transport/ingestion-signing.js';

/** `POST` e não `GET`: a rota exige assinatura, e a assinatura exige corpo. Ver o controller. */
const AUDIT_PATH = '/v1/instrumentation-audit';

export type AuditFinding = {
  serviceId: string;
  service: string;
  check: string;
  severity: 'ok' | 'warn' | 'fail';
  params?: Record<string, string | number>;
  guide?: string;
};

export type AuditResponse = {
  score: number;
  summary: { services: number; fails: number; warns: number; score: number };
  findings: AuditFinding[];
};

export type FetchAuditResult = { ok: true; audit: AuditResponse } | { ok: false; status?: number; detail: string };

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json?: () => Promise<unknown>; text?: () => Promise<string> }>;

export async function fetchAudit(
  input: { endpoint: string; apiKey: string },
  fetchImpl: FetchLike,
): Promise<FetchAuditResult> {
  // Corpo vazio, mas corpo: `rawBody` só existe depois do parser de JSON, e sem ele o preHandler
  // devolve 401 antes de olhar a assinatura.
  const body = '{}';
  const url = `${input.endpoint.replace(/\/$/, '')}${AUDIT_PATH}`;

  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': input.apiKey,
        ...signIngestionRequest({ apiKey: input.apiKey, method: 'POST', path: AUDIT_PATH, serializedBody: body }),
      },
      body,
    });

    if (!res.ok) {
      const detail = res.text !== undefined ? (await res.text().catch(() => '')).slice(0, 200) : '';
      return { ok: false, status: res.status, detail };
    }

    const parsed = (await res.json?.()) as { data?: AuditResponse } | null;
    const audit = parsed?.data;
    if (audit === undefined || !Array.isArray(audit.findings)) {
      return { ok: false, status: res.status, detail: 'unexpected response shape' };
    }
    return { ok: true, audit };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
