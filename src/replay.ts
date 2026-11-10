import './env';
import { parseArgs } from 'node:util';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import { z } from 'zod';
import { ReplayModule } from './replay/replay.module';
import { TaskEventReplayer } from './replay/task-event-replayer';

/**
 * Comando de replay do Event Store (Módulo 13.6b): `npm run replay` em desenvolvimento, `node dist/replay` no build.
 *
 * ```
 * npm run replay                              # o histórico inteiro
 * npm run replay -- --aggregate <taskId>      # uma tarefa
 * npm run replay -- --batch-size 100
 * ```
 *
 * Ferramenta OPERACIONAL, por isso em `src/` (entra no build e na imagem), e não em `scripts/`. Grava na outbox e
 * termina; quem publica é o relay, que precisa estar rodando. Uso típico: reconstruir uma projeção (runbook no
 * Módulo 13) ou levar a um consumer novo o histórico que o tópico já não retém (7 dias).
 *
 * Sem telemetria própria: é um comando curto, e o resultado (tarefas e mensagens) sai no log.
 */
const argsSchema = z.object({
  aggregate: z.uuid().optional(),
  'batch-size': z.coerce.number().int().min(1).max(1_000).optional(),
});

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      aggregate: { type: 'string' },
      'batch-size': { type: 'string' },
    },
  });
  const args = argsSchema.parse(values);

  const app = await NestFactory.createApplicationContext(ReplayModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(PinoLogger));
  const logger = new Logger('Replay');
  try {
    const started = performance.now();
    const report = await app.get(TaskEventReplayer).replay({
      aggregateId: args.aggregate,
      batchSize: args['batch-size'],
    });
    logger.log(
      `Replay gravado na outbox: ${report.aggregates} tarefa(s), ${report.messages} mensagem(ns), em ${Math.round(performance.now() - started)} ms. O relay publica a partir daqui`,
    );
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  new Logger('Replay').error(
    'Replay falhou (o lote em andamento foi desfeito; os anteriores ficaram na outbox)',
    err instanceof Error ? err.stack : err,
  );
  process.exit(1);
});
