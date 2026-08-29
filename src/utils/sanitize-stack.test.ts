import { describe, expect, it } from 'vitest';
import { sanitizeStackTrace } from './sanitize-stack.js';

const BS = String.fromCharCode(92);
const win = (p: string): string => p.split('/').join(BS);

/** Todo caso usa raiz explícita: a detecção automática é do ambiente, não do contrato. */
const at = (stack: string, appRoot: string): string => sanitizeStackTrace(stack, { appRoot });

describe('sanitizeStackTrace — caminho relativo à raiz da aplicação', () => {
  it('torna relativo o frame da aplicacao, preservando arquivo e linha', () => {
    const out = at('    at criarPedido (/home/deploy/app/src/orders.ts:42:11)', '/home/deploy/app');
    expect(out).toBe('    at criarPedido (src/orders.ts:42:11)');
  });

  // O motivo de existir da correcao: ate 2026-08-28 este frame virava `(...)`, e o desenvolvedor
  // perdia arquivo e linha justamente do codigo dele.
  it('nao destroi mais o frame da aplicacao', () => {
    const out = at('    at criarPedido (/home/deploy/app/src/orders.ts:42:11)', '/home/deploy/app');
    expect(out).not.toContain('(...)');
    expect(out).toContain('42:11');
  });

  it('torna relativo tambem o frame de biblioteca', () => {
    const out = at('    at handler (/home/deploy/app/node_modules/fastify/lib/route.js:210:5)', '/home/deploy/app');
    expect(out).toBe('    at handler (node_modules/fastify/lib/route.js:210:5)');
  });

  // O vazamento que a versao antiga tinha: ela preservava o frame de node_modules INTEIRO, com o
  // mesmo `/home/deploy` que ela existia para esconder.
  it('nao vaza a raiz do host por nenhum frame', () => {
    const stack = [
      '    at criarPedido (/home/deploy/app/src/orders.ts:42:11)',
      '    at handler (/home/deploy/app/node_modules/fastify/lib/route.js:210:5)',
    ].join('\n');
    expect(at(stack, '/home/deploy/app')).not.toContain('/home/deploy');
  });

  it('normaliza separador do Windows para barra', () => {
    const out = at('    at criarPedido (' + win('C:/app/src/orders.ts') + ':42:11)', win('C:/app'));
    expect(out).toBe('    at criarPedido (src/orders.ts:42:11)');
  });

  // Windows nao diferencia maiuscula de minuscula em caminho; o stack pode vir com a letra de
  // unidade num caso e o cwd noutro.
  it('compara raiz do Windows sem diferenciar maiusculas', () => {
    const out = at('    at f (' + win('C:/App/src/a.ts') + ':1:1)', win('c:/app'));
    expect(out).toBe('    at f (src/a.ts:1:1)');
  });

  it('trata URL file:// de ESM', () => {
    const out = at('    at criarPedido (file:///srv/app/src/orders.js:42:11)', '/srv/app');
    expect(out).toBe('    at criarPedido (src/orders.js:42:11)');
  });

  it('trata file:// com letra de unidade do Windows', () => {
    const out = at('    at f (file:///C:/app/src/a.js:1:1)', win('C:/app'));
    expect(out).toBe('    at f (src/a.js:1:1)');
  });

  it('preserva frame interno do Node, que nao e caminho de arquivo', () => {
    const linha = '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)';
    expect(at(linha, '/app')).toBe(linha);
  });

  it('preserva a linha de mensagem intacta', () => {
    const linha = 'TypeError: Cannot read properties of undefined';
    expect(at(linha, '/app')).toBe(linha);
  });

  it('aceita frame sem nome de funcao', () => {
    expect(at('    at /srv/app/src/boot.ts:9:1', '/srv/app')).toBe('    at src/boot.ts:9:1');
  });

  // Caminho fora da raiz e exatamente o layout do host que a funcao existe para esconder — e nao
  // ha como torna-lo relativo a coisa nenhuma.
  it('redige caminho absoluto fora da raiz da aplicacao', () => {
    const out = at('    at f (/usr/lib/node_modules/npm/index.js:1:1)', '/srv/app');
    expect(out).toBe('    at f (...)');
  });

  it('redige caminho do Windows fora da raiz', () => {
    const out = at('    at f (' + win('D:/Users/dev/outro/foo.ts') + ':10:5)', win('C:/app'));
    expect(out).not.toContain('D:' + BS + 'Users');
    expect(out).toContain('(...)');
  });

  it('preserva ordem e quantidade de linhas', () => {
    const stack = [
      'Error: x',
      '    at a (/srv/app/src/a.ts:1:1)',
      '    at b (/srv/app/node_modules/z/b.js:2:2)',
      '    at c (node:internal/x:3:3)',
    ].join('\n');
    expect(at(stack, '/srv/app').split('\n')).toHaveLength(4);
  });

  it('sem raiz detectavel, redige em vez de vazar', () => {
    const out = sanitizeStackTrace('    at f (/home/alguem/app/src/a.ts:1:1)', { appRoot: null });
    expect(out).toBe('    at f (...)');
  });
});
