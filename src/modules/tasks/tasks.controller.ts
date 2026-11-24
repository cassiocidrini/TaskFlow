import {
  applyDecorators,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AppClient } from '../../common/client/app-client.decorator';
import type { ClientInfo } from '../../common/client/client-info';
import { CursorPaginationDto } from '../../common/dto/pagination.dto';
import {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENT_REPLAYED_HEADER,
  parseIdempotencyKey,
  requestHash,
} from '../../common/idempotency/idempotency-key';
import { CurrentUser, type AuthenticatedUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { FeatureFlags } from '../feature-flags/feature-flags';
import { TASK_LIST_WITH_STATS, TaskListRolloutMetrics } from './task-list.rollout';
import { CreateTaskCommand, type CreateTaskResult, type DueInput } from './commands/create-task.command';
import type { TaskSnapshot } from './commands/task-command.runner';
import {
  AssignTaskCommand,
  ChangeTaskStatusCommand,
  CompleteTaskCommand,
} from './commands/task-lifecycle.commands';
import { GetTasksQuery } from './queries/get-tasks.query';
import { GetTaskHistoryQuery } from './queries/get-task-history.query';
import type { TaskHistory } from './queries/get-task-history.handler';
import { CreateTaskDto } from './dto/create-task.dto';
import { AssignTaskDto, ChangeTaskStatusDto } from './dto/task-lifecycle.dto';
import { CreateTaskResponseDto, TaskHistoryDto, TaskPageDto, TaskSnapshotDto } from './dto/task.responses';

/** Toda rota valida os IDs da URL como UUID v4: entrada malformada vira 400 antes de tocar no banco (OWASP A03). */
const UUID_V4 = new ParseUUIDPipe({ version: '4' });

// ── Blocos de documentação reutilizados (uma definição, várias rotas) ─────────────────────────────
const ProjectIdParam = () =>
  ApiParam({ name: 'projectId', description: 'ID do projeto (UUID v4)', example: 'bab4a090-6a9f-41eb-b3f6-b0302ee4cf87' });

const TaskIdParam = () =>
  ApiParam({ name: 'taskId', description: 'ID da tarefa (UUID v4)', example: '370b268e-18ba-444c-ae17-2716b0269232' });

/** Erros comuns a toda rota de tarefa: entrada inválida, autenticação e autorização por projeto. */
const CommonTaskErrors = () =>
  applyDecorators(
    ApiResponse({ status: 400, description: 'Entrada inválida: ID que não é UUID v4, body fora do contrato ou campo não permitido.' }),
    ApiResponse({ status: 401, description: 'Token ausente ou inválido.' }),
    ApiResponse({ status: 404, description: 'Projeto ou tarefa inexistente **ou de outro usuário** (anti-enumeração, anti-IDOR).' }),
  );

/** Erro adicional dos comandos que alteram uma tarefa existente. */
const LifecycleConflict = () =>
  ApiResponse({
    status: 409,
    description:
      'Regra de negócio violada (a tarefa já está concluída) **ou** conflito de concorrência: outra requisição alterou a tarefa ' +
      'entre a leitura e a gravação. Recarregue e tente de novo.',
  });

/**
 * Borda HTTP das tarefas — o módulo que aplica **CQRS + Event Sourcing**.
 *
 * - **Escrita** → `CommandBus`: cada rota vira UM comando de domínio. O handler reconstrói o agregado a
 *   partir dos eventos, aplica a regra e grava novos eventos com concorrência otimista.
 * - **Leitura** → `QueryBus`: a listagem lê o Read Model (`tasks_read`), e o histórico lê o Event Store.
 *
 * O controller não tem regra de negócio: valida a entrada, monta o comando com o `userId` do JWT (nunca do
 * body — anti-IDOR, OWASP A01) e despacha. `@UseGuards` na classe = *secure by default*: antes desta
 * correção, estas rotas eram públicas.
 */
@ApiTags('tasks')
@ApiBearerAuth()
@Controller('projects/:projectId/tasks')
@UseGuards(JwtAuthGuard)
export class TasksController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    private readonly flags: FeatureFlags,
    private readonly rollout: TaskListRolloutMetrics,
  ) {}

  @Post()
  @ApiOperation({
    summary: 'Criar tarefa',
    description:
      'Grava o evento `TaskCreated` no Event Store. A prioridade é calculada pelo servidor a partir do título. ' +
      'A tarefa aparece na listagem após a projeção (consistência eventual, normalmente milissegundos). ' +
      'Prazo: `due { at, timezone }` (o `dueDate` antigo foi removido e responde 400). ' +
      '**Repetir com segurança:** envie `Idempotency-Key` (um UUID por intenção, o mesmo em toda nova tentativa). ' +
      'A mesma chave com o mesmo pedido devolve a MESMA resposta (o mesmo `taskId`), sem criar outra tarefa, com ' +
      '`Idempotent-Replayed: true`; com um pedido diferente, 422. Validade: 24 h.',
  })
  @ProjectIdParam()
  @ApiHeader({
    name: IDEMPOTENCY_KEY_HEADER,
    required: false,
    description:
      'Chave de idempotência (1 a 255 caracteres ASCII visíveis; recomendado: UUID v4). Inválida: 400. Por usuário.',
    schema: { type: 'string', maxLength: 255, pattern: '^[\\x21-\\x7E]{1,255}$' },
  })
  @ApiResponse({
    status: 201,
    description: 'Tarefa criada, ou a resposta da criação anterior com a mesma `Idempotency-Key`.',
    type: CreateTaskResponseDto,
    headers: {
      [IDEMPOTENT_REPLAYED_HEADER]: {
        description: '`true` quando a resposta é a repetição de uma criação anterior com a mesma chave',
        schema: { type: 'string', enum: ['true'] },
      },
    },
  })
  @ApiResponse({
    status: 422,
    description: '`code: IDEMPOTENCY_KEY_REUSED`: a mesma `Idempotency-Key` já foi usada num pedido diferente.',
  })
  @CommonTaskErrors()
  async create(
    @Param('projectId', UUID_V4) projectId: string,
    @Body() body: CreateTaskDto,
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') rawKey: string | undefined,
    @Res({ passthrough: true }) res: Response, // passthrough: o Nest continua serializando o retorno
  ) {
    const key = parseIdempotencyKey(rawKey);
    // "O mesmo pedido" = método + rota + corpo já validado (serialização estável: a ordem das chaves não importa)
    const idempotency = key
      ? { key, requestHash: requestHash('POST', `/projects/${projectId}/tasks`, body) }
      : undefined;

    // O CommandBus devolve `any`: o tipo explícito aqui é o que impede devolver o objeto inteiro como `taskId`
    const result: CreateTaskResult = await this.commandBus.execute(
      new CreateTaskCommand(user.userId, projectId, body.title, body.assigneeId, toDueInput(body), idempotency),
    );
    if (result.replayed) res.setHeader(IDEMPOTENT_REPLAYED_HEADER, 'true');
    return { taskId: result.taskId };
  }

  @Get()
  @ApiOperation({
    summary: 'Listar tarefas do projeto',
    description:
      'Lê o Read Model (`tasks_read`): rápido e paginado por cursor. Para a próxima página, envie o `nextCursor` recebido como `?cursor=`. ' +
      'Com a feature `task-list-with-stats` ligada para o usuário (ver `GET /me/features`), a PRIMEIRA página traz também `stats`, ' +
      'os números do projeto (eventualmente consistentes: veja o `asOf`).',
  })
  @ProjectIdParam()
  @ApiResponse({ status: 200, description: 'Página de tarefas.', type: TaskPageDto })
  @CommonTaskErrors()
  async list(
    @Param('projectId', UUID_V4) projectId: string,
    @Query() page: CursorPaginationDto,
    @CurrentUser() user: AuthenticatedUser,
    @AppClient() client: ClientInfo,
  ) {
    // A flag decide AQUI, e a consulta só recebe o resultado: o handler da listagem não conhece flags (Módulo 14.7)
    const withStats = await this.flags.isEnabled(TASK_LIST_WITH_STATS, { userId: user.userId, client });
    return this.rollout.measure(withStats ? 'with-stats' : 'control', !page.cursor, () =>
      this.queryBus.execute(new GetTasksQuery(user.userId, projectId, page.limit, page.cursor, withStats)),
    );
  }

  /**
   * Auditoria: o histórico não é um log à parte — ele É o dado (Event Sourcing). O estado atual é
   * reconstruído na hora a partir dos mesmos eventos, por isso nunca diverge da linha do tempo.
   */
  @Get(':taskId/history')
  @ApiOperation({
    summary: 'Histórico de eventos da tarefa',
    description:
      'Linha do tempo completa (quem mudou o quê e quando) lida do Event Store, com o estado atual reconstruído a ' +
      'partir dos eventos. Cada evento traz o autor (`actorId`) e o `correlationId` da requisição que o gerou; em ' +
      'eventos antigos, gravados antes desse registro, os dois vêm `null`.',
  })
  @ProjectIdParam()
  @TaskIdParam()
  @ApiResponse({ status: 200, description: 'Histórico e estado atual.', type: TaskHistoryDto })
  @CommonTaskErrors()
  history(
    @Param('projectId', UUID_V4) projectId: string,
    @Param('taskId', UUID_V4) taskId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<TaskHistory> {
    return this.queryBus.execute(new GetTaskHistoryQuery({ userId: user.userId, projectId, taskId }));
  }

  // ── Ciclo de vida: cada rota = um comando de domínio, executado pelo TaskCommandRunner ───────────

  @Patch(':taskId/assignee')
  @ApiOperation({
    summary: 'Atribuir responsável',
    description: 'Grava `TaskAssigned`. Atribuir ao mesmo responsável atual não gera evento (comando idempotente).',
  })
  @ProjectIdParam()
  @TaskIdParam()
  @ApiResponse({ status: 200, description: 'Responsável atribuído.', type: TaskSnapshotDto })
  @CommonTaskErrors()
  @LifecycleConflict()
  assign(
    @Param('projectId', UUID_V4) projectId: string,
    @Param('taskId', UUID_V4) taskId: string,
    @Body() body: AssignTaskDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<TaskSnapshot> {
    return this.commandBus.execute(new AssignTaskCommand({ userId: user.userId, projectId, taskId }, body.assigneeId));
  }

  @Patch(':taskId/status')
  @ApiOperation({
    summary: 'Mudar status (PENDING ⇄ IN_PROGRESS)',
    description: 'Grava `TaskStatusChanged` registrando a origem e o destino. Para concluir, use `POST …/complete`.',
  })
  @ProjectIdParam()
  @TaskIdParam()
  @ApiResponse({ status: 200, description: 'Status alterado.', type: TaskSnapshotDto })
  @CommonTaskErrors()
  @LifecycleConflict()
  changeStatus(
    @Param('projectId', UUID_V4) projectId: string,
    @Param('taskId', UUID_V4) taskId: string,
    @Body() body: ChangeTaskStatusDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<TaskSnapshot> {
    return this.commandBus.execute(new ChangeTaskStatusCommand({ userId: user.userId, projectId, taskId }, body.status));
  }

  /** Concluir é uma AÇÃO de domínio (terminal, registra `completedAt`), não "setar status = DONE". */
  @Post(':taskId/complete')
  @HttpCode(HttpStatus.OK) // ação sobre recurso existente: 200, não 201 (nada foi "criado")
  @ApiOperation({
    summary: 'Concluir tarefa',
    description: 'Grava `TaskCompleted`. É terminal: depois de concluída, a tarefa não aceita novos comandos (409).',
  })
  @ProjectIdParam()
  @TaskIdParam()
  @ApiResponse({ status: 200, description: 'Tarefa concluída.', type: TaskSnapshotDto })
  @CommonTaskErrors()
  @LifecycleConflict()
  complete(
    @Param('projectId', UUID_V4) projectId: string,
    @Param('taskId', UUID_V4) taskId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<TaskSnapshot> {
    return this.commandBus.execute(new CompleteTaskCommand({ userId: user.userId, projectId, taskId }));
  }
}

/** JSON ISO → `Date` na borda (Módulo 14.4). Desde o contract (14.4b), o prazo só chega no formato `due`. */
function toDueInput(body: CreateTaskDto): DueInput | undefined {
  return body.due ? { at: new Date(body.due.at), timezone: body.due.timezone } : undefined;
}
