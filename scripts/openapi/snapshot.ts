/**
 * Snapshot do contrato da API (Módulo 14.3): `docs/api/openapi.json`, gerado do código COMPILADO.
 *
 *   npm run openapi:generate   build + reescreve o snapshot (rode quando mudar a API, e revise o diff)
 *   npm run openapi:check      build + falha se o snapshot não bate com o código (o CI roda este)
 *
 * **Do `dist/`, e não do TypeScript:** o plugin do Swagger (`nest-cli.json`) só roda no `nest build`. É ele que
 * completa os DTOs a partir dos tipos e do `class-validator`; sem ele (`ts-node`, `ts-jest`), o documento sairia
 * diferente do que a API serve em `/docs`, e o snapshot não seria o contrato real.
 *
 * Não precisa de banco nem de servidor: o Nest monta o container sem rodar `onModuleInit` (o Prisma não conecta), e o
 * documento sai só dos metadados. Por isso as variáveis obrigatórias recebem valores fictícios aqui.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { firstDifferences, stableStringify } from './stable-json';

const ROOT = join(__dirname, '..', '..');
export const SNAPSHOT_PATH = join(ROOT, 'docs', 'api', 'openapi.json');

// Valores que só precisam passar na validação do ambiente: nada aqui abre conexão
process.env.DATABASE_URL = 'postgresql://openapi:openapi@127.0.0.1:1/openapi';
process.env.JWT_SECRET = 'openapi-snapshot-sem-uso-real-0123456789abcdef';
process.env.LOG_LEVEL = 'silent';

async function generate(): Promise<string> {
  // `require` do código compilado, de propósito (ver o cabeçalho): import estático puxaria o fonte TypeScript
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { NestFactory } =
    require('@nestjs/core') as typeof import('@nestjs/core');
  const { AppModule } = require(join(ROOT, 'dist', 'app.module')) as {
    AppModule: unknown;
  };
  const { buildOpenApiDocument } = require(join(ROOT, 'dist', 'app.setup')) as {
    buildOpenApiDocument: (app: INestApplication) => unknown;
  };
  /* eslint-enable @typescript-eslint/no-require-imports */

  const app = await NestFactory.create(AppModule as never, { logger: false });
  try {
    return stableStringify(buildOpenApiDocument(app));
  } finally {
    await app.close();
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode !== '--write' && mode !== '--check') {
    throw new Error('uso: snapshot.ts --write | --check');
  }
  const current = await generate();

  if (mode === '--write') {
    writeFileSync(SNAPSHOT_PATH, current);
    console.log(
      `[OK] docs/api/openapi.json atualizado. Revise o diff: é o contrato que os apps instalados enxergam.`,
    );
    return;
  }

  let saved = '';
  try {
    saved = readFileSync(SNAPSHOT_PATH, 'utf8');
  } catch {
    // Sem snapshot: cai no "diferente" abaixo, com a mesma instrução
  }
  if (saved === current) {
    console.log('[OK] O contrato da API bate com docs/api/openapi.json');
    return;
  }
  console.error(
    [
      '[X] O contrato da API mudou e docs/api/openapi.json não foi atualizado.',
      '',
      ...firstDifferences(saved, current),
      '',
      'Se a mudança é intencional: npm run openapi:generate e commite o arquivo no mesmo PR.',
      'Para saber se ela quebra apps já instalados: npm run openapi:diff (mudanças incompatíveis contra a main).',
    ].join('\n'),
  );
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
