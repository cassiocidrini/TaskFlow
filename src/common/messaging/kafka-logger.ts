import type { Logger } from '@nestjs/common';
import { KafkaJS } from '@confluentinc/kafka-javascript';

/**
 * Logs da librdkafka pelo Logger do Nest (pino nos processos do relay e dos consumers). O logger padrão do cliente faz
 * `console.warn({ ...objeto })`: um objeto multilinha fora do JSON, que um agregador de logs quebraria em vários
 * registros soltos. Aqui sai uma linha JSON por evento, com os campos da librdkafka em `kafka`.
 *
 * Compartilhado pelo relay (produtor) e pelos consumers do Kafka.
 */
export function toKafkaLogger(
  logger: Logger,
  initial = KafkaJS.logLevel.WARN,
): KafkaJS.Logger {
  let level = initial;
  const entry = (message: string, extra?: object) => ({
    msg: message,
    kafka: extra,
  });
  const adapter: KafkaJS.Logger = {
    error: (message, extra) => {
      if (level >= KafkaJS.logLevel.ERROR) logger.error(entry(message, extra));
    },
    warn: (message, extra) => {
      if (level >= KafkaJS.logLevel.WARN) logger.warn(entry(message, extra));
    },
    info: (message, extra) => {
      if (level >= KafkaJS.logLevel.INFO) logger.log(entry(message, extra));
    },
    debug: (message, extra) => {
      if (level >= KafkaJS.logLevel.DEBUG) logger.debug(entry(message, extra));
    },
    namespace: () => adapter,
    setLogLevel: (newLevel) => {
      level = newLevel;
    },
  };
  return adapter;
}
