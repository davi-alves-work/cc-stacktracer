/**
 * Snippet de inicialização por stack detectada.
 *
 * **Divergir da tela de integrações é pior que não ter snippet:** o dev compara os dois, vê
 * diferença, e para de confiar em ambos. A forma canônica é a de `integrations.snippets.init` nos
 * locales — `StackTrace.auto` com as três variáveis de ambiente —, e é dela que estes derivam.
 *
 * Quando não há stack detectada o snippet cai no genérico, que funciona em qualquer runtime Node.
 * Nunca inventa um campo de framework por palpite.
 */
import type { DbStack, DetectedStack, HttpStack } from './detect-stack.js';

const IMPORT_LINE = "import { StackTrace } from 'cc-stacktracer';";

const ENV_LINES = [
  '  apiKey: process.env.STACKTRACE_API_KEY!,',
  '  serviceId: process.env.STACKTRACE_SERVICE_ID!,',
  '  endpoint: process.env.STACKTRACE_ENDPOINT!,',
];

/** `auto` conecta Fastify, Prisma e Lucid e roda os hooks na ordem certa — é o caminho recomendado. */
function autoBlock(extra: string[]): string {
  return ['await StackTrace.auto({', ...ENV_LINES, ...extra, '});'].join('\n');
}

function httpExtra(http: HttpStack | null): string[] {
  switch (http) {
    case 'fastify':
      return ['', '  fastify: app, // registra o plugin HTTP e instrumenta toda requisicao'];
    case 'adonis':
      // Adonis nao expoe a app no boot como o Fastify: o middleware entra na stack de rotas.
      return ['', '  // Adonis: registre stacktraceAdonisMiddleware() na stack de middleware de rotas'];
    case 'express':
      return ['', '  // Express: app.use(stacktraceExpressMiddleware()) depois deste init'];
    default:
      return [];
  }
}

function dbHint(db: DbStack | null): string[] {
  switch (db) {
    case 'prisma':
      return [
        '',
        '// Prisma: o plugin oficial instrumenta toda query como span `db`.',
        "import { createPrismaStackTracePlugin } from 'cc-stacktracer/db-prisma';",
        'StackTrace.register(createPrismaStackTracePlugin(prisma));',
      ];
    case 'lucid':
      return [
        '',
        '// Lucid/Knex: instrumentacao global pelo subpath dedicado.',
        "import { createLucidStackTracePlugin } from 'cc-stacktracer/db-lucid';",
        'StackTrace.register(createLucidStackTracePlugin(db));',
      ];
    default:
      return [
        '',
        '// Sem ORM reconhecido: envolva as queries importantes para gerar spans `db`.',
        "await StackTrace.runQuery('postgres', 'users.findByEmail', () => findByEmail(email), { table: 'users' });",
      ];
  }
}

export function buildInitSnippet(stack: Pick<DetectedStack, 'http' | 'db'>): string {
  return [IMPORT_LINE, '', autoBlock(httpExtra(stack.http)), ...dbHint(stack.db)].join('\n');
}

/**
 * Mensagem quando o `package.json` do diretório atual não declara dependência nenhuma.
 *
 * É o caso do monorepo: rodar na raiz de um repo com workspaces encontra zero dependências, e sem
 * esta frase o dev leria "stack não reconhecida" num projeto Fastify e concluiria que o CLI não
 * funciona. A promessa de "nunca adivinha em silêncio" cobre o palpite errado E a omissão.
 */
export function emptyPackageJsonHint(cwd: string): string {
  return [
    `No dependencies found in ${cwd}/package.json.`,
    'If this is a monorepo, run the doctor inside the application package — the root manifest',
    'does not declare the framework and ORM this check looks for.',
  ].join('\n');
}

/** Mais de uma stack HTTP presente: diz quais e deixa o dev escolher, em vez de decidir por ele. */
export function ambiguousStackHint(chosen: HttpStack, others: HttpStack[]): string {
  return [
    `More than one HTTP stack found: ${[chosen, ...others].join(', ')}.`,
    `The snippet below assumes ${chosen}. If that is not the one serving traffic, instrument the other instead.`,
  ].join('\n');
}
