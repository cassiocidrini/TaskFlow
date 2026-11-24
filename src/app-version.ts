import './env';
import { userInfo } from 'node:os';
import { parseArgs } from 'node:util';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger as PinoLogger } from 'nestjs-pino';
import { z } from 'zod';
import {
  AppVersionPolicyAdmin,
  describe,
  VersionPolicyRefusedError,
} from './app-version-policy/app-version-policy.admin';
import { PrismaService } from './prisma/prisma.service';
import { ReplayModule } from './replay/replay.module';

/**
 * Comando da política de versão do app (Módulo 14.2): `npm run app-version` em desenvolvimento,
 * `node dist/app-version` no build.
 *
 * ```
 * npm run app-version -- --show                                                   # política de cada plataforma
 * npm run app-version -- --platform ios --min 2.10.0 --by "ana (INC-123)"         # bloqueia abaixo da 2.10.0
 * npm run app-version -- --platform ios --recommended 2.12.0 --dry-run            # antes → depois, sem gravar
 * npm run app-version -- --platform ios --min none                                # remove a mínima
 * ```
 *
 * A API passa a aplicar em até `APP_VERSION_POLICY_CACHE_TTL_MS` (30 s), em todas as réplicas, sem deploy. **Antes de
 * subir a mínima, olhe o painel "Clientes"** (Módulo 14.1): ele diz quantas requisições ainda vêm de versões abaixo dela,
 * e cada uma vai virar uma tela de "atualize o app".
 *
 * Reaproveita o `ReplayModule` (ambiente sem `JWT_SECRET`, Prisma e logs): é o mesmo tipo de comando operacional.
 */
const version = z
  .string()
  .transform((value) => (value === 'none' ? null : value));

const argsSchema = z
  .object({
    show: z.boolean().default(false),
    platform: z.enum(['ios', 'android', 'web']).optional(),
    min: version.optional(),
    recommended: version.optional(),
    'dry-run': z.boolean().default(false),
    by: z.string().min(1).optional(),
  })
  .refine(
    (args) =>
      args.show ||
      (args.platform !== undefined &&
        (args.min !== undefined || args.recommended !== undefined)),
    {
      message:
        'use --show, ou --platform <ios|android|web> com --min e/ou --recommended (<versão> ou none)',
    },
  );

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      show: { type: 'boolean' },
      platform: { type: 'string' },
      min: { type: 'string' },
      recommended: { type: 'string' },
      'dry-run': { type: 'boolean' },
      by: { type: 'string' },
    },
  });
  const args = argsSchema.parse(values);

  const app = await NestFactory.createApplicationContext(ReplayModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(PinoLogger));
  const logger = new Logger('AppVersion');
  try {
    const admin = new AppVersionPolicyAdmin(app.get(PrismaService));
    if (args.show) {
      const policies = await admin.show();
      if (policies.length === 0)
        logger.log('Nenhuma política: todas as versões passam');
      for (const p of policies) {
        logger.log(
          `${p.platform}: ${describe(p)} (por ${p.updatedBy} em ${p.updatedAt.toISOString()})`,
        );
      }
      return;
    }
    // Garantido pelo refine do schema; a checagem só deixa isso explícito para o compilador
    if (!args.platform)
      throw new VersionPolicyRefusedError('--platform é obrigatório');
    const report = await admin.change({
      platform: args.platform,
      minVersion: args.min,
      recommendedVersion: args.recommended,
      requestedBy: args.by ?? userInfo().username,
      dryRun: args['dry-run'],
    });
    const prefix = args['dry-run'] ? '[dry-run] ' : '';
    logger.log(
      report.changed
        ? `${prefix}${report.platform}: ${describe(report.before)} → ${describe(report.after)}${args['dry-run'] ? ' (nada gravado)' : ''}`
        : `${report.platform}: nada a mudar (${describe(report.before)})`,
    );
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  const logger = new Logger('AppVersion');
  if (err instanceof VersionPolicyRefusedError || err instanceof z.ZodError) {
    logger.error(
      err instanceof z.ZodError ? z.prettifyError(err) : err.message,
    );
  } else {
    logger.error(
      'Mudança da política de versão falhou (nada foi gravado: a mudança é uma transação)',
      err instanceof Error ? err.stack : err,
    );
  }
  process.exit(1);
});
