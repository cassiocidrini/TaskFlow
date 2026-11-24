/**
 * Política de versão do app contra PostgreSQL REAL (Testcontainers) — Módulo 14.2.
 *
 * Protege o que o comando `npm run app-version` promete a quem opera:
 * - mudar grava a política E a auditoria (antes/depois, quem), na mesma transação;
 * - `--dry-run` calcula o resultado sem gravar nada; repetir o mesmo valor não gera auditoria;
 * - mínima acima da recomendada é recusada com mensagem legível (e o banco também recusa, pela CHECK, para quem
 *   escrever direto na tabela); a comparação é NUMÉRICA (`1.10.0` > `1.9.0`), no código e no SQL;
 * - remover as duas versões apaga a política (a plataforma volta a "tudo passa"), com auditoria;
 * - o `VersionPolicyService` da API lê o que o comando gravou.
 */
import { PrismaClient } from '@prisma/client';
import type { ConfigService } from '@nestjs/config';
import {
  AppVersionPolicyAdmin,
  VersionPolicyRefusedError,
} from '../../src/app-version-policy/app-version-policy.admin';
import { VersionPolicyService } from '../../src/common/client/version-policy.service';
import type { Env } from '../../src/config/env.schema';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { startTestDatabase, TestDatabase } from './support/test-database';

describe('Política de versão do app (integração)', () => {
  let db: TestDatabase;
  let prisma: PrismaClient;
  let admin: AppVersionPolicyAdmin;

  beforeAll(async () => {
    db = await startTestDatabase();
    prisma = db.prisma;
    admin = new AppVersionPolicyAdmin(prisma as unknown as PrismaService);
  }, 120_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "app_version_policies", "app_version_policy_changes"',
    );
  });

  const change = (
    overrides: Partial<Parameters<AppVersionPolicyAdmin['change']>[0]>,
  ) =>
    admin.change({
      platform: 'ios',
      requestedBy: 'ana',
      dryRun: false,
      ...overrides,
    });

  it('grava a política e a auditoria (antes → depois, quem)', async () => {
    await change({ minVersion: '2.10.0', recommendedVersion: '2.12.0' });
    const report = await change({
      minVersion: '2.11.0',
      requestedBy: 'bia (INC-7)',
    });

    expect(report).toMatchObject({
      before: { minVersion: '2.10.0', recommendedVersion: '2.12.0' },
      after: { minVersion: '2.11.0', recommendedVersion: '2.12.0' },
      changed: true,
    });
    expect(
      await prisma.appVersionPolicy.findUnique({ where: { platform: 'ios' } }),
    ).toMatchObject({
      minVersion: '2.11.0',
      updatedBy: 'bia (INC-7)',
    });
    const audit = await prisma.appVersionPolicyChange.findMany({
      orderBy: { id: 'asc' },
    });
    expect(
      audit.map((a) => [a.previousMinVersion, a.minVersion, a.changedBy]),
    ).toEqual([
      [null, '2.10.0', 'ana'],
      ['2.10.0', '2.11.0', 'bia (INC-7)'],
    ]);
  });

  it('--dry-run não grava nada; repetir o mesmo valor não gera auditoria', async () => {
    const dry = await change({ minVersion: '2.10.0', dryRun: true });
    expect(dry).toMatchObject({ before: null, changed: true });
    expect(await prisma.appVersionPolicy.count()).toBe(0);

    await change({ minVersion: '2.10.0' });
    const again = await change({ minVersion: '2.10.0' });
    expect(again.changed).toBe(false);
    expect(await prisma.appVersionPolicyChange.count()).toBe(1);
  });

  it('mínima acima da recomendada: recusada pelo comando (numérico: 1.10.0 > 1.9.0) e pela CHECK do banco', async () => {
    await expect(
      change({ minVersion: '1.10.0', recommendedVersion: '1.9.0' }),
    ).rejects.toBeInstanceOf(VersionPolicyRefusedError);
    // Mas 1.9.0 ≤ 1.10.0 é válido (como texto, seria o contrário)
    await expect(
      change({ minVersion: '1.9.0', recommendedVersion: '1.10.0' }),
    ).resolves.toMatchObject({
      changed: true,
    });

    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE app_version_policies SET min_version = '1.11.0' WHERE platform = 'ios'`,
      ),
    ).rejects.toThrow('app_version_policies_min_not_above_recommended');
  });

  it('versão em formato inválido: recusada antes de abrir transação', async () => {
    await expect(change({ minVersion: '2.10' })).rejects.toThrow(
      'versão inválida',
    );
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO app_version_policies (platform, min_version, updated_by) VALUES ('android', 'v2', 'x')`,
      ),
    ).rejects.toThrow('app_version_policies_min_version_format');
  });

  it('remover as duas versões apaga a política, com auditoria', async () => {
    await change({ minVersion: '2.10.0' });
    const report = await change({ minVersion: null });

    expect(report).toMatchObject({ after: null, changed: true });
    expect(await prisma.appVersionPolicy.count()).toBe(0);
    expect(await prisma.appVersionPolicyChange.count()).toBe(2);
  });

  it('a API (VersionPolicyService) lê o que o comando gravou', async () => {
    await change({ platform: 'android', minVersion: '3.0.0' });
    const config = { get: () => 0 } as unknown as ConfigService<Env, true>;
    const service = new VersionPolicyService(
      prisma as unknown as PrismaService,
      config,
    );

    expect(await service.policyFor('android')).toEqual({
      minVersion: { major: 3, minor: 0, patch: 0 },
      recommendedVersion: null,
    });
    expect(await service.policyFor('ios')).toBeUndefined();
  });
});
