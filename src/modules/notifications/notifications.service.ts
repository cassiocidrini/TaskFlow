import { Injectable } from '@nestjs/common';
import type { Notification } from '@prisma/client';
import type { CursorPage } from '../../common/dto/pagination.dto';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Leitura das notificações pela API. Quem ESCREVE é o consumer (`consumer/notifications.handler.ts`), em outro
 * processo: o que aparece aqui é eventualmente consistente (milissegundos a segundos depois do comando, ou mais se
 * o relay ou o consumer estiverem parados).
 */
@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Notificações do usuário, mais recentes primeiro, paginadas por cursor (mesmo padrão da listagem de tarefas).
   * O filtro por `userId` vem do JWT: não existe forma de pedir as de outro usuário (OWASP A01).
   */
  async listForUser(
    userId: string,
    limit: number,
    cursor?: string,
  ): Promise<CursorPage<Notification>> {
    const rows = await this.prisma.notification.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1, // 1 a mais para saber se há próxima página, sem COUNT(*)
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
    });
    const hasNextPage = rows.length > limit;
    const items = hasNextPage ? rows.slice(0, limit) : rows;
    return {
      items,
      nextCursor: hasNextPage ? items[items.length - 1].id : null,
    };
  }
}
