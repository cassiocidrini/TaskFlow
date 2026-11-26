/**
 * O manifesto da API no Kubernetes (`k8s/base`) é coerente com a aplicação (Módulo 02, etapa 2.3).
 *
 * Protege regras que cruzam ARQUIVOS e que nenhuma ferramenta confere sozinha:
 * - o ConfigMap passa no schema de ambiente da app: um valor inválido ali só apareceria como CrashLoopBackOff
 *   depois do deploy;
 * - o orçamento do encerramento está em camadas, drenagem < watchdog < SIGKILL do kubelet. O schema já garante a
 *   primeira desigualdade, mas a segunda junta o ConfigMap (`SHUTDOWN_TIMEOUT_MS`) e o Deployment
 *   (`terminationGracePeriodSeconds`). Invertida, o kubelet mata o processo no meio da drenagem, sem log;
 * - liveness e startup apontam para `/health/live`, e NUNCA para `/health/ready`. Com a liveness no readiness, um
 *   Postgres fora do ar reiniciaria todas as réplicas juntas (*restart storm*), sem resolver nada.
 *
 * Os manifestos são lidos como texto, sem parser de YAML, porque os campos conferidos têm uma ocorrência só e
 * formato fixo. Validação completa de manifestos (schema do Kubernetes) é a etapa 2.6.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateEnv } from '../../src/config/env.schema';

const K8S = join(__dirname, '..', '..', 'k8s', 'base');
const api = readFileSync(join(K8S, 'api.yaml'), 'utf8');
const config = readFileSync(join(K8S, 'config.yaml'), 'utf8');

/** As chaves de `data:` do ConfigMap, como o `envFrom` as entrega ao container (sempre string). */
function configMapData(): Record<string, string> {
  const data = config.split(/^data:\s*$/m)[1] ?? '';
  const entries = [...data.matchAll(/^ {2}([A-Z0-9_]+):\s*'?([^'\s]*)'?\s*$/gm)];
  return Object.fromEntries(entries.map(([, key, value]) => [key, value]));
}

/** O `path` do httpGet de uma probe do container da API. */
function probePath(probe: string): string | undefined {
  const block = api.split(new RegExp(`^\\s+${probe}:\\s*$`, 'm'))[1];
  return block?.match(/^\s+path:\s*(\S+)/m)?.[1];
}

describe('manifesto da API no Kubernetes', () => {
  // Os segredos vêm de Secrets (fora do Git): aqui, só valores que passam no schema
  const secrets = { DATABASE_URL: 'postgresql://taskflow:x@postgres:5432/taskflow', JWT_SECRET: 'a'.repeat(32) };
  const env = validateEnv({ ...configMapData(), ...secrets });

  it('o ConfigMap passa no schema de ambiente, em modo produção', () => {
    expect(env.NODE_ENV).toBe('production');
  });

  it('encerramento em camadas: drenagem < watchdog < terminationGracePeriodSeconds', () => {
    const grace = Number(api.match(/^\s+terminationGracePeriodSeconds:\s*(\d+)/m)?.[1]);

    expect(env.SHUTDOWN_DRAIN_MS).toBeGreaterThan(0);
    expect(env.SHUTDOWN_DRAIN_MS).toBeLessThan(env.SHUTDOWN_TIMEOUT_MS);
    expect(env.SHUTDOWN_TIMEOUT_MS).toBeLessThan(grace * 1000);
  });

  it.each([
    ['startupProbe', '/health/live'],
    ['livenessProbe', '/health/live'],
    ['readinessProbe', '/health/ready'],
  ])('%s aponta para %s', (probe, path) => {
    expect(probePath(probe)).toBe(path);
  });
});
