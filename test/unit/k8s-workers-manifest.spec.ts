/**
 * Os workers e o Kafka no Kubernetes (`k8s/base`) são coerentes com o projeto (Módulo 02, etapa 2.4).
 *
 * Protege regras que cruzam arquivos, a mesma lição dos "quatro lugares" do Postgres (2.2):
 * - **tópico é contrato:** os tópicos do Job `kafka-topics` (cluster) são os do `kafka-init` (docker-compose.yml), com
 *   as mesmas partições, replicação e configurações. Se só um lado mudar, o cluster e o desenvolvimento passam a ter
 *   contratos diferentes: outra unidade de paralelismo, outra retenção;
 * - o ConfigMap `taskflow-workers` passa nos schemas do relay e dos consumers: um valor inválido só apareceria como
 *   CrashLoopBackOff depois do deploy;
 * - cada worker roda a MESMA imagem da API (o artefato único da E.1) e um entrypoint que existe em `src/`;
 * - o watchdog do encerramento (`SHUTDOWN_TIMEOUT_MS`) fica abaixo do SIGKILL do kubelet em cada worker.
 *
 * Os manifestos são lidos como texto, sem parser de YAML, como no `k8s-api-manifest.spec.ts`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateConsumerEnv } from '../../src/config/consumer-env.schema';
import { validateRelayEnv } from '../../src/config/relay-env.schema';

const ROOT = join(__dirname, '..', '..');
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');
const workers = read('k8s/base/workers.yaml');

/** `tópico partições=N replicação=N configs` de cada `kafka-topics.sh --create`, com as quebras de linha `\` unidas. */
function topics(script: string): string[] {
  // `\s*` dos DOIS lados da barra: com o espaço antes dela sobrando, o `--config` da linha seguinte deixava de casar
  // e a retenção não era comparada (a mutação da retenção passava; pego pelo teste de mutação)
  const joined = script.replace(/\s*\\\s*\n\s*/g, ' ');
  return [...joined.matchAll(/--topic (\S+) --partitions (\d+) --replication-factor (\d+)((?: --config \S+)*)/g)]
    .map(([, name, partitions, rf, configs]) => `${name} partições=${partitions} replicação=${rf}${configs}`)
    .sort();
}

/** As chaves de `data:` do ConfigMap dos workers (o primeiro documento do arquivo). */
function workersConfig(): Record<string, string> {
  const data = workers.split(/^data:\s*$/m)[1]?.split(/^---$/m)[0] ?? '';
  const entries = [...data.matchAll(/^ {2}([A-Z0-9_]+):\s*'?([^'\s]*)'?\s*$/gm)];
  return Object.fromEntries(entries.map(([, key, value]) => [key, value]));
}

describe('manifestos dos workers e do Kafka no Kubernetes', () => {
  it('os tópicos do Job kafka-topics são os do kafka-init do compose (contrato)', () => {
    const compose = topics(read('docker-compose.yml'));
    const cluster = topics(read('k8s/base/kafka-topics-job.yaml'));

    expect(cluster).toHaveLength(4);
    expect(cluster).toEqual(compose);
  });

  describe('ConfigMap taskflow-workers', () => {
    // A senha vem do Secret (fora do Git): aqui, só uma URL que passa no schema
    const env = { ...workersConfig(), DATABASE_URL: 'postgresql://taskflow:x@postgres:5432/taskflow' };

    it('passa no schema do relay e no dos consumers, em modo produção', () => {
      expect(validateRelayEnv(env)).toMatchObject({ NODE_ENV: 'production', KAFKA_BROKERS: ['kafka:9092'] });
      expect(validateConsumerEnv(env)).toMatchObject({ NODE_ENV: 'production', KAFKA_BROKERS: ['kafka:9092'] });
    });

    it('o watchdog do encerramento fica abaixo do terminationGracePeriodSeconds de cada worker', () => {
      const graces = [...workers.matchAll(/^\s+terminationGracePeriodSeconds:\s*(\d+)/gm)].map(([, s]) => Number(s));

      expect(graces).toHaveLength(3);
      for (const grace of graces) {
        expect(validateRelayEnv(env).SHUTDOWN_TIMEOUT_MS).toBeLessThan(grace * 1000);
      }
    });
  });

  it('cada worker roda a imagem da API e um entrypoint que existe em src/', () => {
    const apiImage = read('k8s/base/api.yaml').match(/^\s+image:\s*(\S+)/m)?.[1];
    const images = [...workers.matchAll(/^\s+image:\s*(\S+)/gm)].map(([, image]) => image);
    const commands = [...workers.matchAll(/^\s+command:\s*\['node', 'dist\/([\w-]+)'\]/gm)].map(([, entry]) => entry);

    expect(images).toEqual([apiImage, apiImage, apiImage]);
    expect(commands).toEqual(['relay', 'notifications-consumer', 'reports-consumer']);
    for (const entry of commands) {
      expect(existsSync(join(ROOT, 'src', `${entry}.ts`))).toBe(true);
    }
  });
});
