/**
 * Adapter SQS do push (Módulo 13.7).
 *
 * Protege as duas promessas da porta `PushQueue` que o `NotificationsHandler` usa dentro da transação:
 * - o corpo enviado é o pedido serializado, na fila configurada (é o contrato que a Lambda lê);
 * - QUALQUER falha do envio sai como `InfrastructureError`, e por isso o runner tenta para sempre em vez de mandar
 *   o evento ao DLT.
 *
 * As falhas são REAIS, não erros montados à mão: um `SQSClient` de verdade, com as retentativas do SDK, contra
 * - uma porta fechada (conexão recusada na hora, o SQS fora do ar);
 * - um servidor que ACEITA a conexão e nunca responde (o LocalStack pausado). Este caso pendurava o consumer para
 *   sempre: o `requestTimeout` do SDK só avisava (Módulo 13, problema 37). O teste prova que o envio desiste dentro
 *   do orçamento, antes dos 5 s da transação do Prisma.
 */
import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { SQSClient, type SendMessageCommand } from '@aws-sdk/client-sqs';
import { InfrastructureError } from '../../src/common/messaging/consumer-errors';
import {
  PUSH_REQUEST_VERSION,
  type PushRequest,
} from '../../src/modules/notifications/consumer/push-queue';
import { SqsPushQueue } from '../../src/modules/notifications/consumer/sqs-push-queue';

const QUEUE_URL = 'http://localhost:4566/000000000000/taskflow-push';

const request: PushRequest = {
  version: PUSH_REQUEST_VERSION,
  pushId: '8f0c6a52-8d6b-4f4e-9d7f-5d3c2b1a0e9f',
  userId: '1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9',
  type: 'TASK_ASSIGNED',
  body: 'Você foi atribuído à tarefa "Conciliar pagamentos"',
  taskId: '2c3d4e5f-6071-4829-93a4-b5c6d7e8f901',
  projectId: '3d4e5f60-7182-4930-a4b5-c6d7e8f90123',
  requestedAt: '2026-11-24T00:00:00.000Z',
};

describe('SqsPushQueue', () => {
  it('envia o pedido serializado para a fila configurada', async () => {
    const sent: SendMessageCommand[] = [];
    const client = {
      send: (command: SendMessageCommand) => {
        sent.push(command);
        return Promise.resolve({ MessageId: 'm-1' });
      },
    } as unknown as SQSClient;

    await new SqsPushQueue(
      { queueUrl: QUEUE_URL, region: 'us-east-1' },
      client,
    ).enqueue(request);

    expect(sent).toHaveLength(1);
    expect(sent[0].input.QueueUrl).toBe(QUEUE_URL);
    expect(JSON.parse(sent[0].input.MessageBody ?? '')).toEqual(request);
  });

  it('SQS inalcançável (conexão recusada de verdade) vira InfrastructureError com a causa', async () => {
    const client = new SQSClient({
      region: 'us-east-1',
      endpoint: 'http://127.0.0.1:1', // porta 1: ninguém escuta, recusa na hora
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      maxAttempts: 2,
    });
    const queue = new SqsPushQueue(
      { queueUrl: QUEUE_URL, region: 'us-east-1' },
      client,
    );

    const enqueue = queue.enqueue(request);

    await expect(enqueue).rejects.toBeInstanceOf(InfrastructureError);
    await expect(enqueue).rejects.toThrow(request.pushId);
    queue.onApplicationShutdown();
  });

  describe('servidor que aceita a conexão e não responde (LocalStack pausado)', () => {
    let server: Server;
    const sockets: Socket[] = [];

    beforeAll(async () => {
      server = createServer((socket) => sockets.push(socket)); // aceita e fica em silêncio
      await new Promise<void>((resolve) => server.listen(0, resolve));
    });

    afterAll(async () => {
      sockets.forEach((socket) => socket.destroy());
      await new Promise((resolve) => server.close(resolve));
    });

    it('desiste dentro do orçamento (antes dos 5 s da transação) com InfrastructureError', async () => {
      const { port } = server.address() as AddressInfo;
      process.env.AWS_ACCESS_KEY_ID ??= 'test';
      process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
      // O cliente PADRÃO do adapter (com os timeouts dele), só com o endpoint apontado para o servidor mudo
      const queue = new SqsPushQueue({
        queueUrl: QUEUE_URL,
        region: 'us-east-1',
        endpoint: `http://127.0.0.1:${port}`,
      });

      const started = Date.now();
      await expect(queue.enqueue(request)).rejects.toBeInstanceOf(
        InfrastructureError,
      );
      expect(Date.now() - started).toBeLessThan(4_000);
      queue.onApplicationShutdown();
    });
  });
});
