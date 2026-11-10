import './env';
import { userInfo } from 'node:os';
import { parseArgs } from 'node:util';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Logger as PinoLogger } from 'nestjs-pino';
import { z } from 'zod';
import type { RelayEnv } from './config/relay-env.schema';
import { PrismaService } from './prisma/prisma.service';
import { DltRedriver, RedriveRefusedError } from './redrive/dlt-redriver';
import { REDRIVE_POLICIES } from './redrive/redrive-policy';
import { ReplayModule } from './replay/replay.module';

/**
 * Comando de redrive do DLT (Módulo 13.6c): `npm run redrive` em desenvolvimento, `node dist/redrive` no build.
 *
 * ```
 * npm run redrive -- --group notifications --dry-run            # o que seria reenviado, sem publicar
 * npm run redrive -- --group notifications --by "ana (INC-123)"  # reenvia as `exhausted`
 * npm run redrive -- --group notifications --include-permanent   # também as `permanent`
 * ```
 *
 * Uso típico: um bug no handler fez mensagens esgotarem as tentativas; o bug foi corrigido e implantado; o redrive
 * as devolve ao tópico de origem, e só o grupo que falhou as processa. Rode de novo sem medo: o que já foi reenviado
 * está em `dlt_redrives` e é pulado.
 *
 * Reaproveita o `ReplayModule` (ambiente do relay, Prisma e logs): é o mesmo tipo de comando operacional.
 */
const argsSchema = z.object({
  group: z.enum(Object.keys(REDRIVE_POLICIES) as [string, ...string[]]),
  'include-permanent': z.boolean().default(false),
  'dry-run': z.boolean().default(false),
  by: z.string().min(1).optional(),
});

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      group: { type: 'string' },
      'include-permanent': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      by: { type: 'string' },
    },
  });
  const args = argsSchema.parse(values);

  const app = await NestFactory.createApplicationContext(ReplayModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(PinoLogger));
  const logger = new Logger('Redrive');
  try {
    const redriver = new DltRedriver(
      app.get(PrismaService),
      app
        .get<ConfigService<RelayEnv, true>>(ConfigService)
        .get('KAFKA_BROKERS', { infer: true }),
      logger,
    );
    const report = await redriver.redrive({
      group: args.group,
      includePermanent: args['include-permanent'],
      dryRun: args['dry-run'],
      requestedBy: args.by ?? userInfo().username,
    });
    logger.log(
      `${args['dry-run'] ? '[dry-run] ' : ''}Redrive de "${args.group}": ${report.read} lida(s) no DLT, ${report.redriven} ${args['dry-run'] ? 'seriam reenviadas' : 'reenviada(s)'}, ${report.alreadyRedriven} já reenviada(s) antes, ${report.skipped} pulada(s)`,
    );
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  const logger = new Logger('Redrive');
  if (err instanceof RedriveRefusedError) {
    logger.error(err.message);
  } else {
    logger.error(
      'Redrive falhou (o que já foi reenviado está em dlt_redrives; rodar de novo continua daí)',
      err instanceof Error ? err.stack : err,
    );
  }
  process.exit(1);
});
