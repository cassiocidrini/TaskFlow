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
 *   Postgres fora do ar reiniciaria todas as réplicas juntas (*restart storm*), sem resolver nada;
 * - (2.5) com HPA, o Deployment NÃO declara `replicas`: cada `kubectl apply` devolveria a API ao número do arquivo no
 *   meio de um pico, brigando com o HPA;
 * - (2.5) `TRUST_PROXY_HOPS > 0` só com a NetworkPolicy da API fechada: a app passa a acreditar no X-Forwarded-For, e
 *   isso é seguro só se apenas o Envoy (e as cargas de medição) alcançarem a API. Medido: sem a política, um pod
 *   falando direto com a API forjou o IP em 10 requisições seguidas e nunca chegou ao 429 (Módulo 06).
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
const autoscaling = readFileSync(join(K8S, 'autoscaling.yaml'), 'utf8');
const networkPolicies = readFileSync(join(K8S, 'network-policies.yaml'), 'utf8');

/** Um documento de um arquivo com vários (`---`), pelo `kind` e `name`. */
function doc(file: string, kind: string, name: string): string {
  return (
    file
      .split(/^---$/m)
      .find((d) => new RegExp(`^kind: ${kind}$`, 'm').test(d) && new RegExp(`^  name: ${name}$`, 'm').test(d)) ?? ''
  );
}

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

  describe('escala e disponibilidade (2.5)', () => {
    const hpa = doc(autoscaling, 'HorizontalPodAutoscaler', 'taskflow-api');
    const pdb = doc(autoscaling, 'PodDisruptionBudget', 'taskflow-api');
    const deployment = doc(api, 'Deployment', 'taskflow-api');

    it('o HPA mira o Deployment da API, e o Deployment não declara replicas (um dono só para o campo)', () => {
      expect(hpa).toMatch(/^ {4}kind: Deployment\n {4}name: taskflow-api$/m);
      expect(deployment).not.toMatch(/^ {2}replicas:/m);
    });

    it('nunca menos de 2 réplicas, e o PDB deixa sair no máximo 1 por vez', () => {
      const min = Number(hpa.match(/^ {2}minReplicas:\s*(\d+)/m)?.[1]);

      expect(min).toBeGreaterThanOrEqual(2);
      expect(pdb).toMatch(/^ {2}maxUnavailable: 1$/m);
    });

    it('as réplicas se espalham pelos nós, sem contar os nós que a API não pode usar (nodeTaintsPolicy: Honor)', () => {
      expect(deployment).toMatch(/topologyKey: kubernetes\.io\/hostname/);
      expect(deployment).toMatch(/whenUnsatisfiable: DoNotSchedule/);
      expect(deployment).toMatch(/nodeTaintsPolicy: Honor/);
    });
  });

  it('TRUST_PROXY_HOPS > 0 só com a rede da API fechada: entrada negada por padrão, aberta só ao Envoy e às cargas', () => {
    expect(env.TRUST_PROXY_HOPS).toBeGreaterThan(0);

    const denyAll = doc(networkPolicies, 'NetworkPolicy', 'default-deny-ingress');
    const apiPolicy = doc(networkPolicies, 'NetworkPolicy', 'taskflow-api');
    // As origens permitidas: cada `- namespaceSelector`/`- podSelector` da lista `from`, sem regra aberta (`from: []`
    // ou um item vazio liberaria todo mundo)
    const sources = [...apiPolicy.matchAll(/^ {8}- (namespaceSelector|podSelector):/gm)].map(([, kind]) => kind);

    expect(denyAll).toMatch(/^ {2}podSelector: \{\}$/m);
    expect(apiPolicy).toMatch(/^ {6}app\.kubernetes\.io\/name: taskflow-api$/m);
    expect(sources).toEqual(['namespaceSelector', 'podSelector']);
    expect(apiPolicy).toMatch(/kubernetes\.io\/metadata\.name: envoy-gateway-system/);
    expect(apiPolicy).toMatch(/app\.kubernetes\.io\/component: load-test/);
    expect(apiPolicy).not.toMatch(/- \{\}|from: \[\]/);
  });
});
