const warned = new Set<string>();

/**
 * A 3.0 removeu o `captureErrors` das integracoes: a captura de erros agora e automatica (Error Tracking).
 * O tipo nao aceita mais a opcao, mas JavaScript sem tipos — ou a opcao passada por variavel — chega aqui.
 * Ela e ignorada, e o aviso sai uma vez por integracao, nao a cada requisicao.
 */
export function warnRemovedCaptureErrors(opts: unknown, where: string): void {
  if (typeof opts !== 'object' || opts === null || !('captureErrors' in opts) || warned.has(where)) return;
  warned.add(where);
  console.warn(
    `cc-stacktracer 3.0: captureErrors was removed from ${where} — errors are now captured automatically ` +
      '(Error Tracking). To turn it off: init({ errorTracking: false }).',
  );
}

export function resetRemovedOptionWarnings(): void {
  warned.clear();
}
