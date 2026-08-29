/**
 * Decide o que fazer com os avisos que o servidor manda junto da capture policy.
 *
 * Fica **fora** do `CapturePolicyCache` de propósito: o cache entrega os avisos parseados, e a
 * política de logar (uma vez? por ciclo? silenciada?) é de quem o instancia. Um cache que sabe o
 * que é um logger vira dois problemas num arquivo só.
 */
import { renderNoticeLine } from '../../cli/finding-text.js';
import type { CapturePolicyNotice } from '../../shared/schema/index.js';

export type NoticeLogger = (line: string) => void;

export type RuntimeNoticeReporterOptions = {
  /** Silencia tudo. Log não solicitado em produção irrita — a flag é obrigatória. */
  suppress?: boolean | undefined;
  log?: NoticeLogger | undefined;
};

/**
 * Loga cada `code` **uma vez por processo**.
 *
 * O polling repete a cada ciclo (mínimo 60s). Sem a deduplicação, um serviço sem `service_version`
 * imprimiria a mesma linha a cada minuto até alguém desligar o SDK — e o aviso viraria ruído,
 * ensinando o dev a ignorar exatamente o canal que existe para ele prestar atenção.
 */
export function createRuntimeNoticeReporter(
  options: RuntimeNoticeReporterOptions = {},
): (notices: CapturePolicyNotice[]) => void {
  const seen = new Set<string>();
  const log = options.log ?? ((line: string) => console.warn(line));

  return (notices) => {
    if (options.suppress === true) return;
    for (const notice of notices) {
      if (seen.has(notice.code)) continue;
      seen.add(notice.code);
      log(renderNoticeLine({ check: notice.code, params: notice.params }));
    }
  };
}
