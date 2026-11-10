import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CursorPaginationDto } from '../../common/dto/pagination.dto';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { NotificationPageDto } from './dto/notification.responses';
import { NotificationsService } from './notifications.service';

/**
 * Borda HTTP das notificações (Módulo 13.4). `/me/...`: o recurso é SEMPRE o do usuário do token — não há id de
 * usuário na URL para alguém trocar (anti-IDOR por construção). `@UseGuards` na classe: secure by default.
 */
@ApiTags('notifications')
@ApiBearerAuth()
@Controller('me/notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOperation({
    summary: 'Listar minhas notificações',
    description:
      'Notificações geradas pelo consumer `notifications` a partir dos eventos de tarefa publicados no Kafka (atribuição e conclusão). Eventualmente consistente: aparecem depois que o relay publica e o consumer processa o evento.',
  })
  @ApiResponse({
    status: 200,
    description: 'Página de notificações (pode ser vazia).',
    type: NotificationPageDto,
  })
  @ApiResponse({
    status: 400,
    description: '`limit` fora de 1–100 ou `cursor` que não é UUID v4.',
  })
  @ApiResponse({ status: 401, description: 'Token ausente ou inválido.' })
  list(
    @Query() page: CursorPaginationDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.notifications.listForUser(user.userId, page.limit, page.cursor);
  }
}
