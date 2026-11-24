import { HttpException, Injectable } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';

/** A flag que liga os números do projeto na listagem de tarefas (Módulo 14.7, critério de avanço no ADR-0011). */
export const TASK_LIST_WITH_STATS = 'task-list-with-stats';

/** O grupo do usuário no rollout: decidido pelo bucket da flag, fixo por usuário. */
export type TaskListVariant = 'control' | 'with-stats';

/**
 * Mede a listagem de tarefas POR VARIANTE do rollout da `task-list-with-stats` (Módulo 14.7): é o "experimento feito à
 * mão" que o ADR-0010 citou, e a base do critério de avanço do ADR-0011 (p95 e taxa de erro de `with-stats` contra
 * `control`, na mesma janela).
 *
 * A comparação é justa porque o bucket da flag sorteia os grupos sem relação com o perfil do usuário, e cada usuário
 * fica sempre no mesmo grupo. A label `page` separa a primeira página (a única que paga a consulta a mais) da rolagem:
 * o critério compara só `page="first"`, senão as páginas seguintes, iguais nos dois grupos, diluiriam a diferença.
 *
 * Erro = 5xx ou exceção que não é HTTP. Um 404 de projeto alheio é erro do CLIENTE, igual nas duas variantes, e
 * contá-lo só faria ruído na comparação.
 *
 * Instrumentos criados no construtor, quando o Nest monta a aplicação (depois de o SDK registrar o provider: a API
 * de métricas não tem provider "proxy").
 */
@Injectable()
export class TaskListRolloutMetrics {
  private readonly meter = metrics.getMeter('taskflow-api');
  private readonly duration = this.meter.createHistogram(
    'taskflow_task_list_duration',
    {
      description:
        'Tempo da listagem de tarefas por variante do rollout task-list-with-stats e página, em segundos',
      unit: 's',
      // Buckets em segundos, de 5 ms a 5 s: os padrões do OTel são para ms e inventariam o p95 (problema 31 do 13)
      advice: {
        explicitBucketBoundaries: [
          0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.15, 0.25, 0.5, 1, 2.5, 5,
        ],
      },
    },
  );
  private readonly requests = this.meter.createCounter(
    'taskflow_task_list_requests',
    {
      description:
        'Listagens de tarefas por variante do rollout task-list-with-stats, página e desfecho (ok | error = 5xx)',
    },
  );

  /** Mede a execução e repassa o resultado (ou a exceção) sem alterar nada. */
  async measure<T>(
    variant: TaskListVariant,
    firstPage: boolean,
    run: () => Promise<T>,
  ): Promise<T> {
    const labels = { variant, page: firstPage ? 'first' : 'next' };
    const started = performance.now();
    try {
      const result = await run();
      this.requests.add(1, { ...labels, outcome: 'ok' });
      return result;
    } catch (error) {
      const serverError =
        !(error instanceof HttpException) || error.getStatus() >= 500;
      this.requests.add(1, {
        ...labels,
        outcome: serverError ? 'error' : 'client_error',
      });
      throw error;
    } finally {
      this.duration.record((performance.now() - started) / 1000, labels);
    }
  }
}
