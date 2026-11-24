/**
 * Lambda `push-sender` (Módulo 13.7): processamento do lote da fila de push, sem AWS.
 *
 * Protege o que a Lambda promete ao SQS e ao usuário:
 * - `batchItemFailures` lista SÓ as mensagens que falharam: as boas do mesmo lote não são reenviadas;
 * - push já enviado (`COMPLETED`) não sai de novo: a duplicata vinda do consumer (COMMIT falho depois do envio) é
 *   descartada e sai da fila;
 * - reserva de outra invocação em andamento volta para a fila, sem enviar;
 * - envio que falhou libera a reserva (a próxima tentativa não espera o prazo vencer);
 * - push enviado cuja marca `COMPLETED` falhou NÃO volta para a fila (voltar enviaria de novo);
 * - corpo inválido é falha (vai para a DLQ pelo `maxReceiveCount`), sem derrubar o lote.
 *
 * A idempotência aqui é uma versão em memória com a MESMA regra da condição do DynamoDB; a condição real é exercida
 * no roteiro manual com LocalStack (Módulo 13).
 */
import type { SQSEvent, SQSRecord } from 'aws-lambda';
import { createBatchProcessor } from '../../lambdas/push-sender/batch-processor';
import type {
  BeginResult,
  IdempotencyStore,
} from '../../lambdas/push-sender/idempotency';
import {
  SIMULATED_FAILURE_MARKER,
  SimulatedPushProvider,
} from '../../lambdas/push-sender/push-provider';
import {
  InvalidPushRequestError,
  parsePushRequest,
} from '../../lambdas/push-sender/push-request';

class InMemoryStore implements IdempotencyStore {
  readonly items = new Map<string, 'IN_PROGRESS' | 'COMPLETED'>();
  failComplete = false;

  begin(pushId: string): Promise<BeginResult> {
    const status = this.items.get(pushId);
    if (status === 'COMPLETED') return Promise.resolve('completed');
    if (status === 'IN_PROGRESS') return Promise.resolve('in-progress');
    this.items.set(pushId, 'IN_PROGRESS');
    return Promise.resolve('acquired');
  }

  complete(pushId: string): Promise<void> {
    if (this.failComplete) return Promise.reject(new Error('DynamoDB fora'));
    this.items.set(pushId, 'COMPLETED');
    return Promise.resolve();
  }

  release(pushId: string): Promise<void> {
    if (this.items.get(pushId) === 'IN_PROGRESS') this.items.delete(pushId);
    return Promise.resolve();
  }
}

const body = (pushId: string, text = 'Você foi atribuído à tarefa "X"') =>
  JSON.stringify({
    version: 1,
    pushId,
    userId: 'user-1',
    type: 'TASK_ASSIGNED',
    body: text,
    taskId: 'task-1',
    projectId: 'project-1',
    requestedAt: '2026-11-24T00:00:00.000Z',
  });

const record = (messageId: string, rawBody: string): SQSRecord =>
  ({
    messageId,
    body: rawBody,
    attributes: { ApproximateReceiveCount: '1' },
  }) as SQSRecord;

const batch = (...records: SQSRecord[]): SQSEvent => ({ Records: records });

describe('push-sender: processamento do lote', () => {
  let store: InMemoryStore;
  let sent: string[];
  let process: ReturnType<typeof createBatchProcessor>;

  beforeEach(() => {
    store = new InMemoryStore();
    sent = [];
    const provider = new SimulatedPushProvider((_, fields) =>
      sent.push((fields as { pushId: string }).pushId),
    );
    process = createBatchProcessor({
      store,
      provider,
      logger: { info: () => undefined, error: () => undefined },
    });
  });

  it('lote bom: envia todos, marca COMPLETED e não devolve nada à fila', async () => {
    const result = await process(
      batch(record('m1', body('p1')), record('m2', body('p2'))),
    );

    expect(result.batchItemFailures).toEqual([]);
    expect(sent).toEqual(['p1', 'p2']);
    expect(store.items.get('p1')).toBe('COMPLETED');
  });

  it('lote misto: só a mensagem que falhou volta, e a reserva dela é liberada', async () => {
    const result = await process(
      batch(
        record('m1', body('p1')),
        record('m2', body('p2', `${SIMULATED_FAILURE_MARKER} tarefa`)),
        record('m3', body('p3')),
      ),
    );

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'm2' }]);
    expect(sent).toEqual(['p1', 'p3']);
    expect(store.items.has('p2')).toBe(false); // a próxima tentativa reserva de novo, sem esperar o prazo
  });

  it('duplicata (o consumer reenfileirou o mesmo pushId): não envia e sai da fila', async () => {
    await process(batch(record('m1', body('p1'))));
    const result = await process(batch(record('m9', body('p1'))));

    expect(result.batchItemFailures).toEqual([]);
    expect(sent).toEqual(['p1']);
  });

  it('reserva de outra invocação em andamento: volta para a fila sem enviar', async () => {
    store.items.set('p1', 'IN_PROGRESS');

    const result = await process(batch(record('m1', body('p1'))));

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'm1' }]);
    expect(sent).toEqual([]);
  });

  it('enviado, mas a marca COMPLETED falhou: NÃO volta (voltar enviaria de novo)', async () => {
    store.failComplete = true;

    const result = await process(batch(record('m1', body('p1'))));

    expect(result.batchItemFailures).toEqual([]);
    expect(sent).toEqual(['p1']);
  });

  it('corpo inválido é falha da mensagem, sem derrubar as outras do lote', async () => {
    const result = await process(
      batch(record('m1', 'não é json'), record('m2', body('p2'))),
    );

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'm1' }]);
    expect(sent).toEqual(['p2']);
  });
});

describe('push-sender: contrato da mensagem (leitor tolerante)', () => {
  it('lê só os campos conhecidos; campo extra é ignorado', () => {
    const push = parsePushRequest(
      JSON.stringify({ ...JSON.parse(body('p1')), extra: 'x' }),
    );
    expect(push).not.toHaveProperty('extra');
    expect(push.pushId).toBe('p1');
  });

  it('recusa versão desconhecida e campo obrigatório ausente', () => {
    expect(() =>
      parsePushRequest(
        JSON.stringify({ ...JSON.parse(body('p1')), version: 2 }),
      ),
    ).toThrow(InvalidPushRequestError);
    expect(() =>
      parsePushRequest(
        JSON.stringify({ ...JSON.parse(body('p1')), userId: undefined }),
      ),
    ).toThrow('userId');
  });
});
