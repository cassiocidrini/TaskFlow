import './env';
import { userInfo } from 'node:os';
import { parseArgs } from 'node:util';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger as PinoLogger } from 'nestjs-pino';
import { z } from 'zod';
import {
  describeFlag,
  FeatureFlagAdmin,
  FeatureFlagRefusedError,
} from './modules/feature-flags/admin/feature-flag.admin';
import { PrismaService } from './prisma/prisma.service';
import { ReplayModule } from './replay/replay.module';

/**
 * Comando das feature flags (Módulo 14.6): `npm run feature-flag` em desenvolvimento, `node dist/feature-flag` no build.
 *
 * ```
 * npm run feature-flag -- --show
 * npm run feature-flag -- --key task-list-with-stats --description "Números do projeto na listagem"   # cria DESLIGADA
 * npm run feature-flag -- --key task-list-with-stats --allow <userId1>,<userId2> --enable          # time interno
 * npm run feature-flag -- --key task-list-with-stats --rollout 10 --platforms ios,android --min-app-version 2.15.0
 * npm run feature-flag -- --key task-list-with-stats --kill --by "ana (INC-42)"                     # desliga para todos
 * ```
 *
 * A API passa a aplicar em até `FEATURE_FLAGS_CACHE_TTL_MS` (5 s), em todas as réplicas. `--allow none`,
 * `--platforms all` e `--min-app-version none` limpam a restrição. `--dry-run` mostra o antes → depois sem gravar.
 *
 * Reaproveita o `ReplayModule` (ambiente sem `JWT_SECRET`, Prisma e logs), como os outros comandos operacionais.
 */
const list = (empty: string) =>
  z.string().transform((value) =>
    value === empty
      ? []
      : value
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean),
  );

const argsSchema = z
  .object({
    show: z.boolean().default(false),
    key: z.string().optional(),
    description: z.string().min(1).optional(),
    enable: z.boolean().default(false),
    kill: z.boolean().default(false),
    rollout: z.coerce.number().optional(),
    allow: list('none').optional(),
    platforms: list('all').optional(),
    'min-app-version': z
      .string()
      .transform((value) => (value === 'none' ? null : value))
      .optional(),
    'dry-run': z.boolean().default(false),
    by: z.string().min(1).optional(),
  })
  .refine((args) => !(args.enable && args.kill), {
    message: '--enable e --kill não podem vir juntos',
  })
  .refine((args) => args.show || args.key !== undefined, {
    message: 'use --show, ou --key <flag> com o que mudar',
  });

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      show: { type: 'boolean' },
      key: { type: 'string' },
      description: { type: 'string' },
      enable: { type: 'boolean' },
      kill: { type: 'boolean' },
      rollout: { type: 'string' },
      allow: { type: 'string' },
      platforms: { type: 'string' },
      'min-app-version': { type: 'string' },
      'dry-run': { type: 'boolean' },
      by: { type: 'string' },
    },
  });
  const args = argsSchema.parse(values);

  const app = await NestFactory.createApplicationContext(ReplayModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(PinoLogger));
  const logger = new Logger('FeatureFlag');
  try {
    const admin = new FeatureFlagAdmin(app.get(PrismaService));
    if (args.show || !args.key) {
      const flags = await admin.show();
      if (flags.length === 0) logger.log('Nenhuma flag');
      for (const flag of flags) {
        logger.log(
          `${flag.key}: ${describeFlag(flag)} (por ${flag.updatedBy} em ${flag.updatedAt.toISOString()})`,
        );
      }
      return;
    }
    const report = await admin.change({
      key: args.key,
      description: args.description,
      enabled: args.enable ? true : args.kill ? false : undefined,
      rolloutPercentage: args.rollout,
      allowUserIds: args.allow,
      platforms: args.platforms,
      minAppVersion: args['min-app-version'],
      requestedBy: args.by ?? userInfo().username,
      dryRun: args['dry-run'],
    });
    const prefix = args['dry-run'] ? '[dry-run] ' : '';
    logger.log(
      report.changed
        ? `${prefix}${report.key}: ${describeFlag(report.before)} → ${describeFlag(report.after)}${args['dry-run'] ? ' (nada gravado)' : ''}`
        : `${report.key}: nada a mudar (${describeFlag(report.before)})`,
    );
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  const logger = new Logger('FeatureFlag');
  if (err instanceof FeatureFlagRefusedError || err instanceof z.ZodError) {
    logger.error(
      err instanceof z.ZodError ? z.prettifyError(err) : err.message,
    );
  } else {
    logger.error(
      'Mudança da feature flag falhou (nada foi gravado: a mudança é uma transação)',
      err instanceof Error ? err.stack : err,
    );
  }
  process.exit(1);
});
