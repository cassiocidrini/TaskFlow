/**
 * Métricas do rollout da `task-list-with-stats` (Módulo 14.7), com o OpenTelemetry DE VERDADE em memória.
 *
 * Protege a base do critério de avanço (ADR-0011): cada listagem é contada e medida com a sua variante e a sua página
 * (o critério compara só a primeira, a única que paga a consulta a mais); e o desfecho separa erro do SERVIDOR (5xx ou
 * exceção não HTTP, o que o critério compara) de erro do CLIENTE (um 404 de projeto alheio, igual nas duas variantes,
 * que só faria ruído). O resultado e a exceção passam intactos.
 */
import {
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import {
  AggregationTemporality,
  MeterProvider,
  MetricReader,
} from '@opentelemetry/sdk-metrics';
import { TaskListRolloutMetrics } from '../../src/modules/tasks/task-list.rollout';

class TestMetricReader extends MetricReader {
  constructor() {
    super({
      aggregationTemporalitySelector: () => AggregationTemporality.CUMULATIVE,
    });
  }
  protected onForceFlush(): Promise<void> {
    return Promise.resolve();
  }
  protected onShutdown(): Promise<void> {
    return Promise.resolve();
  }
}

describe('TaskListRolloutMetrics', () => {
  let reader: TestMetricReader;
  let provider: MeterProvider;
  let rollout: TaskListRolloutMetrics;

  beforeEach(() => {
    reader = new TestMetricReader();
    provider = new MeterProvider({ readers: [reader] });
    metrics.setGlobalMeterProvider(provider);
    rollout = new TaskListRolloutMetrics(); // depois do provider: instrumentos de verdade
  });

  afterEach(async () => {
    await provider.shutdown();
    metrics.disable();
  });

  const points = async (name: string) => {
    const { resourceMetrics } = await reader.collect();
    const metric = resourceMetrics.scopeMetrics
      .flatMap((s) => s.metrics)
      .find((m) => m.descriptor.name === name);
    return metric?.dataPoints ?? [];
  };

  it('conta e mede com a variante e a página; o resultado passa intacto', async () => {
    const result = await rollout.measure('with-stats', true, () =>
      Promise.resolve({ items: [] }),
    );
    await rollout.measure('control', false, () =>
      Promise.resolve({ items: [] }),
    );

    expect(result).toEqual({ items: [] });
    const requests = (await points('taskflow_task_list_requests')).map((p) => [
      p.attributes,
      p.value,
    ]);
    expect(requests).toEqual(
      expect.arrayContaining([
        [{ variant: 'with-stats', page: 'first', outcome: 'ok' }, 1],
        [{ variant: 'control', page: 'next', outcome: 'ok' }, 1],
      ]),
    );
    const durations = await points('taskflow_task_list_duration');
    expect(durations.map((p) => p.attributes)).toEqual(
      expect.arrayContaining([
        { variant: 'with-stats', page: 'first' },
        { variant: 'control', page: 'next' },
      ]),
    );
  });

  it('5xx ou exceção não HTTP = error; 404 = client_error; a exceção sobe intacta', async () => {
    const boom = new InternalServerErrorException();
    await expect(
      rollout.measure('with-stats', true, () => Promise.reject(boom)),
    ).rejects.toBe(boom);
    await expect(
      rollout.measure('with-stats', true, () =>
        Promise.reject(new Error('bug')),
      ),
    ).rejects.toThrow('bug');
    await expect(
      rollout.measure('control', true, () =>
        Promise.reject(new NotFoundException()),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    const requests = (await points('taskflow_task_list_requests')).map((p) => [
      p.attributes,
      p.value,
    ]);
    expect(requests).toEqual(
      expect.arrayContaining([
        [{ variant: 'with-stats', page: 'first', outcome: 'error' }, 2],
        [{ variant: 'control', page: 'first', outcome: 'client_error' }, 1],
      ]),
    );
  });
});
