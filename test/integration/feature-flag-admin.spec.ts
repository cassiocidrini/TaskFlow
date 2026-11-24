/**
 * Comando das feature flags contra PostgreSQL REAL (Testcontainers) — Módulo 14.6.
 *
 * Protege o que o `npm run feature-flag` promete a quem opera:
 * - flag nova só com descrição, e nasce DESLIGADA e com 0% (ligar é sempre um passo explícito);
 * - cada mudança grava a regra E a auditoria (antes/depois inteiros, quem), na mesma transação; `--dry-run` não grava;
 *   repetir o mesmo valor não gera auditoria;
 * - validações legíveis no comando e as CHECK no banco para quem escrever direto (porcentagem 0–100, kebab-case);
 * - o adapter da API (`PostgresFeatureFlags`) lê o que o comando gravou, inclusive o kill switch.
 */
import { PrismaClient } from '@prisma/client';
import type { ConfigService } from '@nestjs/config';
import { resolveClientInfo } from '../../src/common/client/client-info';
import type { Env } from '../../src/config/env.schema';
import {
  FeatureFlagAdmin,
  FeatureFlagRefusedError,
} from '../../src/modules/feature-flags/admin/feature-flag.admin';
import { PostgresFeatureFlags } from '../../src/modules/feature-flags/postgres-feature-flags';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { startTestDatabase, TestDatabase } from './support/test-database';

describe('Comando das feature flags (integração)', () => {
  let db: TestDatabase;
  let prisma: PrismaClient;
  let admin: FeatureFlagAdmin;

  beforeAll(async () => {
    db = await startTestDatabase();
    prisma = db.prisma;
    admin = new FeatureFlagAdmin(prisma as unknown as PrismaService);
  }, 120_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "feature_flags", "feature_flag_changes"',
    );
  });

  const change = (
    overrides: Partial<Parameters<FeatureFlagAdmin['change']>[0]>,
  ) =>
    admin.change({
      key: 'tela-nova',
      requestedBy: 'ana',
      dryRun: false,
      ...overrides,
    });

  it('flag nova: exige descrição e nasce DESLIGADA, com 0%', async () => {
    await expect(change({ rolloutPercentage: 10 })).rejects.toThrow(
      'informe --description',
    );

    const report = await change({ description: 'Tela nova' });

    expect(report.after).toMatchObject({
      enabled: false,
      rolloutPercentage: 0,
      platforms: [],
    });
  });

  it('cada mudança grava a regra e a auditoria (antes → depois, quem); repetir não audita', async () => {
    await change({ description: 'Tela nova' });
    await change({
      enabled: true,
      rolloutPercentage: 10,
      platforms: ['ios', 'android'],
      requestedBy: 'bia',
    });
    const again = await change({ rolloutPercentage: 10 });

    expect(again.changed).toBe(false);
    expect(
      await prisma.featureFlag.findUnique({ where: { key: 'tela-nova' } }),
    ).toMatchObject({
      enabled: true,
      rolloutPercentage: 10,
      platforms: ['ios', 'android'],
      updatedBy: 'bia',
    });
    const audit = await prisma.featureFlagChange.findMany({
      orderBy: { id: 'asc' },
    });
    expect(audit).toHaveLength(2);
    expect(audit[1]).toMatchObject({
      changedBy: 'bia',
      before: expect.objectContaining({ enabled: false, rolloutPercentage: 0 }),
      after: expect.objectContaining({ enabled: true, rolloutPercentage: 10 }),
    });
  });

  it('--dry-run calcula o depois sem gravar nada', async () => {
    const report = await change({ description: 'Tela nova', dryRun: true });
    expect(report.changed).toBe(true);
    expect(await prisma.featureFlag.count()).toBe(0);
    expect(await prisma.featureFlagChange.count()).toBe(0);
  });

  it('validações no comando, e as CHECK no banco para quem escrever direto', async () => {
    await expect(
      change({ key: 'Tela Nova', description: 'x' }),
    ).rejects.toBeInstanceOf(FeatureFlagRefusedError);
    await expect(
      change({ description: 'x', rolloutPercentage: 101 }),
    ).rejects.toThrow('de 0 a 100');
    await expect(
      change({ description: 'x', platforms: ['symbian'] }),
    ).rejects.toThrow('plataforma inválida');
    await expect(
      change({ description: 'x', minAppVersion: '2.15' }),
    ).rejects.toThrow('versão inválida');

    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO feature_flags (key, description, rollout_percentage, updated_by) VALUES ('x', 'x', 150, 'x')`,
      ),
    ).rejects.toThrow('feature_flags_rollout_range');
  });

  it('a API (PostgresFeatureFlags) lê o que o comando gravou, inclusive o kill switch', async () => {
    const flags = new PostgresFeatureFlags(
      prisma as unknown as PrismaService,
      { get: () => 0 } as unknown as ConfigService<Env, true>,
    );
    const ctx = { userId: 'u1', client: resolveClientInfo('ios', '2.15.0') };
    await change({
      description: 'Tela nova',
      enabled: true,
      rolloutPercentage: 100,
    });
    expect(await flags.isEnabled('tela-nova', ctx)).toBe(true);

    await change({ enabled: false });
    expect(await flags.isEnabled('tela-nova', ctx)).toBe(false);
  });
});
