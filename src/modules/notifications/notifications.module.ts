import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

/**
 * Lado da API do contexto de notificações: só LEITURA (`GET /me/notifications`). A escrita mora no processo
 * consumer (`consumer/notifications-consumer.module.ts`), que este módulo não importa: a API não fala com o Kafka.
 */
@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService],
})
export class NotificationsModule {}
