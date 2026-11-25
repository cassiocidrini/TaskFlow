/**
 * As imagens dos testes são as do `docker-compose.yml` (Etapa E.2, Módulo 03).
 *
 * Protege: Postgres, Kafka e Prometheus têm DUAS fontes de versão, o compose (ambiente de desenvolvimento) e as
 * constantes do Testcontainers (o que os testes sobem). Se só uma mudar, os testes passam provando o contrato com
 * um serviço que ninguém usa.
 *
 * Por que um teste, e não o comentário "atualize aqui E no compose" que já existia: na primeira rodada do
 * Dependabot, o PR do Postgres 16 → 18 mexeu só no compose e passou VERDE em todos os checks, porque os testes
 * continuaram no 16.15. Só o Prometheus tinha essa guarda (no teste de integração), e o PR dele foi o único dos
 * três a ficar vermelho. Agora a regra vale para as três imagens e para o smoke da imagem, num teste unitário
 * (sem Docker): o PR desalinhado falha no primeiro minuto do CI e diz o que alinhar.
 *
 * Desde o Módulo 02 (2.2), o Postgres tem uma QUARTA fonte: o StatefulSet do cluster (`k8s/base/postgres.yaml`), por
 * tag e digest. O Dependabot não lê manifestos do Kubernetes, então só este teste impede o cluster de ficar numa
 * versão e o resto do projeto em outra.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KAFKA_TEST_IMAGE } from '../support/kafka-image';
import { POSTGRES_TEST_IMAGE } from '../support/postgres-image';
import { PROMETHEUS_TEST_IMAGE } from '../support/prometheus-image';

const ROOT = join(__dirname, '..', '..');
const compose = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8');

/** A imagem de um serviço do compose (a primeira linha `image:` depois de `  <serviço>:`). */
function composeImage(service: string): string | undefined {
  const block = compose.split(new RegExp(`^  ${service}:\\s*$`, 'm'))[1];
  return block?.match(/^\s+image:\s*(\S+)/m)?.[1];
}

describe('imagens dos testes = imagens do compose', () => {
  it.each([
    ['postgres', POSTGRES_TEST_IMAGE, 'test/support/postgres-image.ts'],
    ['kafka', KAFKA_TEST_IMAGE, 'test/support/kafka-image.ts'],
    ['prometheus', PROMETHEUS_TEST_IMAGE, 'test/support/prometheus-image.ts'],
  ])('serviço %s: o teste usa %s (alinhe %s com o compose no mesmo PR)', (service, testImage) => {
    expect(composeImage(service)).toBe(testImage);
  });

  it('o Postgres do cluster (k8s/base/postgres.yaml) é o do compose, fixado por digest', () => {
    const manifest = readFileSync(join(ROOT, 'k8s/base/postgres.yaml'), 'utf8');
    const [tag, digest] = (manifest.match(/^\s+image:\s*(\S+)/m)?.[1] ?? '').split('@');
    // Tag por IGUALDADE de texto, e o digest por uma regex fixa: montar a regex com o nome da imagem exigiria escapar
    // todos os metacaracteres (o CodeQL apontou o escape só do ponto como incompleto, js/incomplete-sanitization)
    expect(tag).toBe(composeImage('postgres'));
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('o smoke da imagem de produção usa o Postgres do compose', () => {
    const smoke = readFileSync(join(ROOT, 'scripts/docker/image-smoke.mjs'), 'utf8');
    expect(smoke).toContain(`const POSTGRES_IMAGE = '${composeImage('postgres')}';`);
  });
});
