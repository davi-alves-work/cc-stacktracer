import { captureException } from '../index.js';

export type BoundaryCaptureOptions = {
  /**
   * Captura o erro que chega ao boundary HTTP como evento de erro. **Default `false`.**
   *
   * Desligado por padrão porque ligá-lo numa aplicação que já chama `captureException` no próprio error
   * handler dobraria cada ocorrência — inflando a contagem do grupo de erro e o disparo de alerta. Para
   * instalação nova, prefira esta opção ao handler manual: aqui o evento nasce dentro do contexto de
   * requisição e de trace, então `trace_id` e `span_id` saem corretos sem o app fazer nada.
   */
  captureErrors?: boolean;
};

/** Erros já convertidos em evento. WeakSet em vez de marca no próprio erro: o objeto é do usuário, pode
 * estar congelado, e escrever nele lançaria — silenciosamente no Fastify, e substituindo o erro original
 * no Adonis/Express. */
const capturedErrors = new WeakSet<object>();

export function captureBoundaryError(
  err: unknown,
  options: BoundaryCaptureOptions | undefined,
  capture: (error: Error, context: Record<string, unknown>) => void = captureException,
): void {
  if (options?.captureErrors !== true) return;
  const error = err instanceof Error ? err : new Error(String(err));
  if (capturedErrors.has(error)) return;
  capturedErrors.add(error);
  capture(error, { captured_by: 'http-boundary' });
}
