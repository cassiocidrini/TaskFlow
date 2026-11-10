/**
 * Regras de alerta do Prometheus (`prometheus/alerts.yml`) — Módulo 13.6d.
 *
 * Alerta é código: uma PromQL errada não dá erro em lugar nenhum, só deixa de disparar. Esta suíte roda o
 * `promtool` num container com a MESMA versão do Prometheus do compose:
 * - `check rules`: a sintaxe e a PromQL de todas as regras;
 * - `test rules`: os casos de `prometheus/alerts.test.yml` (séries sintéticas e, em cada instante, quais alertas
 *   disparam, com que labels e com que texto). É ali que estão os limiares, os `for`, os filtros de grupo e as duas
 *   armadilhas encontradas: o contador que nasce em 1 e a janela de `rate()` curta demais para o Prometheus 3.
 *
 * Na suíte de integração (e não na unitária) porque precisa de Docker.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GenericContainer, Wait } from 'testcontainers';
import { PROMETHEUS_TEST_IMAGE } from '../support/prometheus-image';

const ROOT = join(__dirname, '..', '..');

/**
 * Roda o `promtool` com `prometheus/` montada e devolve a saída. Por um shell que sempre sai com 0 e imprime o código
 * de saída do `promtool`: assim a saída COMPLETA (qual alerta, em que instante, esperado × obtido) chega à mensagem de
 * erro, em vez de um "container failed to start".
 */
async function promtool(...args: string[]): Promise<string> {
  const started = await new GenericContainer(PROMETHEUS_TEST_IMAGE)
    .withEntrypoint(['/bin/sh', '-c'])
    .withCommand([`promtool ${args.join(' ')} 2>&1; echo "promtool-exit=$?"`])
    .withWorkingDir('/rules')
    .withBindMounts([
      { source: join(ROOT, 'prometheus'), target: '/rules', mode: 'ro' },
    ])
    .withWaitStrategy(Wait.forOneShotStartup())
    .withStartupTimeout(60_000)
    .start();

  let output = '';
  for await (const chunk of await started.logs()) output += String(chunk);
  await started.stop();

  const exit = /promtool-exit=(\d+)/.exec(output)?.[1];
  if (exit !== '0') {
    throw new Error(`promtool ${args.join(' ')} saiu com ${exit}:\n${output}`);
  }
  return output;
}

describe('Regras de alerta do Prometheus (promtool)', () => {
  it('a imagem do teste é a mesma do compose', () => {
    const compose = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8');
    expect(compose).toContain(`image: ${PROMETHEUS_TEST_IMAGE}`);
  });

  it('check rules: todas as regras são válidas', async () => {
    const output = await promtool('check', 'rules', 'alerts.yml');
    expect(output).toMatch(/SUCCESS: \d+ rules found/);
  }, 90_000);

  it('test rules: cada alerta dispara (e só dispara) quando deve, com o texto certo', async () => {
    await expect(
      promtool('test', 'rules', 'alerts.test.yml'),
    ).resolves.toContain('SUCCESS');
  }, 90_000);
});
