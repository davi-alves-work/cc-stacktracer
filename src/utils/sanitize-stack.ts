/**
 * Reescreve os caminhos de um stack trace como **relativos à raiz da aplicação**, antes do envio.
 *
 * ## O que mudou em 2026-08-28, e por quê
 *
 * A versão anterior apagava o caminho inteiro (`(...)`) quando ele começava por `/Users`, `/home`,
 * `/var`, `/tmp` ou `/opt`, ou quando era um caminho do Windows — e **preservava** os frames de
 * `node_modules`. Isso produzia o pior dos dois mundos, medido no mesmo stack:
 *
 * ```
 * at criarPedido (...)                                                    ← perdeu arquivo e linha
 * at handler (/home/deploy/app/node_modules/fastify/lib/route.js:210:5)   ← vazou /home/deploy/app
 * ```
 *
 * Destruía a informação que o desenvolvedor precisa (o frame do código dele) e não cumpria o
 * objetivo de privacidade, porque o prefixo do host escapava pelo frame de biblioteca logo abaixo.
 * E o resultado dependia do layout do deploy: em `/app` ou `/srv/app` (defaults de Docker) o frame
 * da aplicação sobrevivia; em `/home` ou `/var/www`, não. No Windows, nenhum sobrevivia.
 *
 * Agora todo frame sob a raiz vira relativo — `src/orders.ts:42:11`,
 * `node_modules/fastify/lib/route.js:210:5`. O layout do host some de **todos** os frames, nenhum
 * perde arquivo e linha, e o separador é normalizado para `/`, o que faz a mesma heurística de
 * `node_modules` valer em Windows e Unix.
 *
 * Caminho absoluto que **não** está sob a raiz continua sendo redigido: é exatamente o layout de
 * host que a função existe para esconder, e não há a que torná-lo relativo.
 */

/** `\` → `/`, sem barra final. Raiz do Windows fica comparável com o caminho do stack. */
function normalizeSeparators(value: string): string {
  return value.split('\\').join('/').replace(/\/+$/, '');
}

function hasDriveLetter(value: string): boolean {
  return /^[A-Za-z]:\//.test(value);
}

/**
 * Raiz da aplicação em execução.
 *
 * `process.cwd()` acerta o caso normal — processo Node iniciado na raiz do projeto, que é o que
 * `npm start`, Docker `WORKDIR` e todo gerenciador de processo fazem. Fora de Node (browser,
 * worker sem `process`) devolve `null`, e aí a função redige em vez de vazar.
 */
function detectAppRoot(): string | null {
  const cwd = (globalThis as { process?: { cwd?: () => string } }).process?.cwd;
  if (typeof cwd !== 'function') {
    return null;
  }
  try {
    return normalizeSeparators(cwd());
  } catch {
    return null;
  }
}

const DEFAULT_APP_ROOT = detectAppRoot();

/**
 * Um caminho de arquivo dentro de um frame. Cobre as quatro formas que o V8 emite:
 * `(/a/b.js:1:2)`, `(C:\a\b.js:1:2)`, `(file:///a/b.js:1:2)` e `at /a/b.js:1:2` (sem parênteses,
 * quando não há nome de função).
 */
const FRAME_PATH = /(\()(file:\/\/\/|\/|[A-Za-z]:[\\/])([^)]*)(\))|(\s+at\s+)(\/|[A-Za-z]:[\\/])(\S*)/g;

function relativize(rawPath: string, appRoot: string | null): string | null {
  let path = normalizeSeparators(rawPath.replace(/^file:\/\/\//, ''));
  // `file:///C:/a` vira `C:/a`; `file:////srv` (raro) vira `/srv`.
  if (!hasDriveLetter(path) && !path.startsWith('/')) {
    path = `/${path}`;
  }
  if (appRoot === null) {
    return null;
  }
  const root = normalizeSeparators(appRoot);
  // Windows não diferencia maiúsculas em caminho, e o stack pode divergir do `cwd` na letra da
  // unidade ou na caixa de um diretório.
  const caseInsensitive = hasDriveLetter(root) || hasDriveLetter(path);
  const a = caseInsensitive ? path.toLowerCase() : path;
  const b = caseInsensitive ? root.toLowerCase() : root;
  if (a !== b && !a.startsWith(`${b}/`)) {
    return null;
  }
  return path.slice(root.length + 1);
}

export type SanitizeStackOptions = {
  /** Raiz da aplicação. `null` desliga a relativização (tudo absoluto é redigido). */
  appRoot?: string | null;
};

export function sanitizeStackTrace(stack: string, options: SanitizeStackOptions = {}): string {
  const appRoot = options.appRoot === undefined ? DEFAULT_APP_ROOT : options.appRoot;

  return stack.replace(
    FRAME_PATH,
    (
      match,
      open: string | undefined,
      scheme: string | undefined,
      rest: string | undefined,
      close: string | undefined,
      atPrefix: string | undefined,
      bareScheme: string | undefined,
      bareRest: string | undefined,
    ) => {
      const isParenthesized = open !== undefined;
      const raw = isParenthesized ? `${scheme ?? ''}${rest ?? ''}` : `${bareScheme ?? ''}${bareRest ?? ''}`;
      const relative = relativize(raw, appRoot);
      if (relative === null) {
        return isParenthesized ? '(...)' : `${atPrefix ?? ''}...`;
      }
      return isParenthesized ? `${open}${relative}${close ?? ''}` : `${atPrefix ?? ''}${relative}`;
    },
  );
}
