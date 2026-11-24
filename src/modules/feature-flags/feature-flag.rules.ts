import { createHash } from 'node:crypto';
import {
  type AppVersion,
  compareAppVersions,
} from '../../common/client/app-version';
import type { ClientInfo, Platform } from '../../common/client/client-info';

/** A regra de UMA flag, como está no banco (`feature_flags`). */
export interface FlagRule {
  key: string;
  /** Kill switch: `false` desliga para TODOS. */
  enabled: boolean;
  /** 0 a 100. */
  rolloutPercentage: number;
  allowUserIds: readonly string[];
  /** Vazia = todas as plataformas. */
  platforms: readonly Exclude<Platform, 'unknown'>[];
  /** `null` = qualquer versão. */
  minAppVersion: AppVersion | null;
}

/** Quem pergunta: o usuário (do JWT) e o app (dos headers da 14.1). */
export interface EvaluationContext {
  userId: string;
  client: ClientInfo;
}

/** O resultado e o PORQUÊ: a razão vai para a métrica e responde "por que o usuário X não vê a tela?". */
export type Evaluation =
  | {
      enabled: false;
      reason:
        'missing' | 'killed' | 'platform' | 'app-version' | 'outside-rollout';
    }
  | { enabled: true; reason: 'allowlist' | 'rollout' };

/**
 * Avalia uma flag para um usuário (Módulo 14.6). Função PURA, e a ORDEM das regras é a decisão:
 *
 * 1. **Flag inexistente → desligada.** Código que pergunta por uma flag que ninguém criou não liga nada por engano.
 *    É também o que torna o adapter *fail-closed*: sem conseguir ler a configuração, toda flag "não existe".
 * 2. **Kill switch → desligada para todos.** Antes de tudo, inclusive da lista de usuários: em incidente, desligar
 *    tem de ser absoluto.
 * 3. **Restrições** (plataforma, versão mínima do app) → desligada. A tela nova só existe a partir de uma versão;
 *    ligar para um app mais antigo mostraria algo que ele não sabe desenhar. Cliente desconhecido (sem os headers da
 *    14.1) não passa por uma restrição: na dúvida, desligada.
 * 4. **Lista de usuários → ligada** (time interno, beta), independente da porcentagem.
 * 5. **Porcentagem:** `bucket(flag, usuário) < rollout` → ligada.
 */
export function evaluate(
  rule: FlagRule | undefined,
  { userId, client }: EvaluationContext,
): Evaluation {
  if (!rule) return { enabled: false, reason: 'missing' };
  if (!rule.enabled) return { enabled: false, reason: 'killed' };
  if (
    rule.platforms.length > 0 &&
    !rule.platforms.some((p) => p === client.platform)
  ) {
    return { enabled: false, reason: 'platform' };
  }
  if (
    rule.minAppVersion &&
    (!client.appVersion ||
      compareAppVersions(client.appVersion, rule.minAppVersion) < 0)
  ) {
    return { enabled: false, reason: 'app-version' };
  }
  if (rule.allowUserIds.includes(userId)) {
    return { enabled: true, reason: 'allowlist' };
  }
  return bucket(rule.key, userId) < rule.rolloutPercentage
    ? { enabled: true, reason: 'rollout' }
    : { enabled: false, reason: 'outside-rollout' };
}

/**
 * O "grupo" (0 a 99) do usuário numa flag: `sha256("flagKey:userId")`, os 4 primeiros bytes, `mod 100`.
 *
 * - **Determinístico:** o mesmo usuário cai sempre no mesmo grupo, em qualquer réplica e a cada requisição. Sem
 *   isso, a tela apareceria e sumiria aleatoriamente.
 * - **Monotônico:** `bucket < rollout` com o rollout subindo de 10 para 20 mantém os primeiros 10% e acrescenta
 *   outros 10%. Ninguém que já tinha a funcionalidade a perde.
 * - **O nome da flag no hash:** cada flag sorteia os SEUS usuários. Sem ele, os mesmos 10% seriam a cobaia de todo
 *   rollout.
 *
 * `2^32 mod 100` não é exato (o viés de cada grupo é da ordem de 1 em 40 milhões): irrelevante para uma porcentagem.
 */
export function bucket(flagKey: string, userId: string): number {
  const digest = createHash('sha256').update(`${flagKey}:${userId}`).digest();
  return digest.readUInt32BE(0) % 100;
}
