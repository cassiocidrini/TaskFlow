/**
 * Prazo `due { at, timezone }` depois do contract (Módulo 14.4b): o `dueDate` não existe mais na API, mas os eventos
 * antigos continuam gravados com ele.
 *
 * Protege:
 * - o **upcaster**, que fica para sempre: `TaskCreated` v1 (ou legado, sem envelope) vira v2 na LEITURA, com fuso
 *   `null` (nunca inventado); v2 passa intacto; outros tipos não são tocados; versão MAIS NOVA que o código falha
 *   alto; campo inesperado do payload antigo não atravessa;
 * - a **entrada**: `due.at` com fuso explícito, `timezone` como nome IANA (offset recusado), e o `dueDate` removido
 *   (campo desconhecido, recusado pelo `forbidNonWhitelisted`);
 * - a **saída da listagem**: só as colunas novas; a `due_date` (sem uso, sai do banco na 14.4c) não é lida nem vaza;
 * - o **mecanismo de depreciação** (ADR-0008), pronto para o próximo campo: headers das RFCs 9745 e 8594.
 */
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import type { Response } from 'express';
import type { TaskRead } from '@prisma/client';
import { resolveClientInfo } from '../../src/common/client/client-info';
import { DeprecationNotifier } from '../../src/common/deprecation/deprecation';
import { CreateTaskDto } from '../../src/modules/tasks/dto/create-task.dto';
import { isIanaTimeZone } from '../../src/modules/tasks/dto/due.dto';
import { upcastPayload } from '../../src/modules/tasks/infrastructure/task-event.upcasters';
import { toTaskListItem } from '../../src/modules/tasks/queries/get-tasks.handler';

describe('upcaster do TaskCreated (v1 → v2)', () => {
  const v1 = {
    taskId: 't1',
    projectId: 'p1',
    title: 'Pagar boleto',
    priority: 'HIGH',
    assigneeId: 'u2',
    dueDate: '2026-12-31T23:59:59.000Z',
  };

  it('v1 com prazo: vira due { at, timezone: null } (o fuso não foi registrado, e não é inventado)', () => {
    expect(upcastPayload('TaskCreated', v1, 1)).toEqual({
      taskId: 't1',
      projectId: 'p1',
      title: 'Pagar boleto',
      priority: 'HIGH',
      assigneeId: 'u2',
      due: { at: '2026-12-31T23:59:59.000Z', timezone: null },
    });
  });

  it('evento legado sem envelope (schemaVersion ausente) conta como v1', () => {
    expect(upcastPayload('TaskCreated', v1, undefined)).toHaveProperty(
      'due.timezone',
      null,
    );
  });

  it('v1 sem prazo: sem due; campo inesperado do payload antigo não atravessa', () => {
    const { dueDate: _ignorado, ...semPrazo } = v1;
    const result = upcastPayload('TaskCreated', { ...semPrazo, lixo: 1 }, 1);
    expect(result).not.toHaveProperty('due');
    expect(result).not.toHaveProperty('dueDate');
    expect(result).not.toHaveProperty('lixo');
  });

  it('v2 e outros tipos passam intactos', () => {
    const v2 = { ...v1, dueDate: undefined, due: { at: 'x', timezone: 'UTC' } };
    expect(upcastPayload('TaskCreated', v2, 2)).toBe(v2);
    const assigned = { taskId: 't1', assigneeId: 'u2' };
    expect(upcastPayload('TaskAssigned', assigned, 1)).toBe(assigned);
  });

  it('versão MAIS NOVA que o código (deploy revertido): falha alto em vez de adivinhar', () => {
    expect(() => upcastPayload('TaskCreated', v1, 3)).toThrow('mais novo');
  });
});

describe('entrada: CreateTaskDto depois do contract', () => {
  const errorsOf = (body: object) =>
    validateSync(plainToInstance(CreateTaskDto, { title: 'Tarefa', ...body }), {
      whitelist: true,
      forbidNonWhitelisted: true,
    }).flatMap((e) => [
      ...Object.values(e.constraints ?? {}),
      ...(e.children ?? []).flatMap((c) => Object.values(c.constraints ?? {})),
    ]);

  it('due válido: aceito (com offset ou em UTC)', () => {
    expect(
      errorsOf({
        due: { at: '2026-12-31T23:59:59-03:00', timezone: 'America/Sao_Paulo' },
      }),
    ).toEqual([]);
    expect(
      errorsOf({ due: { at: '2026-12-31T23:59:59Z', timezone: 'UTC' } }),
    ).toEqual([]);
  });

  it('dueDate (removido no contract): campo desconhecido, recusado', () => {
    expect(errorsOf({ dueDate: '2026-12-31T23:59:59Z' }).join(' ')).toContain(
      'property dueDate should not exist',
    );
  });

  it('due.at sem fuso explícito (ambíguo): recusado', () => {
    expect(
      errorsOf({ due: { at: '2026-12-31T23:59:59', timezone: 'UTC' } }).join(
        ' ',
      ),
    ).toContain('fuso explícito');
  });

  it('timezone: nome IANA sim; offset, inexistente ou vazio, não', () => {
    expect(isIanaTimeZone('America/Sao_Paulo')).toBe(true);
    expect(isIanaTimeZone('UTC')).toBe(true);
    expect(isIanaTimeZone('-03:00')).toBe(false); // o Intl aceita, mas o campo quer o NOME
    expect(isIanaTimeZone('+0300')).toBe(false);
    expect(isIanaTimeZone('Mars/Olympus_Mons')).toBe(false);
    expect(isIanaTimeZone('')).toBe(false);
    expect(
      errorsOf({
        due: { at: '2026-12-31T23:59:59Z', timezone: 'Terra/Media' },
      }).join(' '),
    ).toContain('fuso IANA');
  });
});

describe('saída: toTaskListItem', () => {
  const row = (overrides: Partial<TaskRead>): TaskRead => ({
    id: 't1',
    projectId: 'p1',
    title: 'Tarefa',
    status: 'PENDING',
    priority: 'MEDIUM',
    assigneeId: null,
    dueDate: null,
    dueAt: null,
    dueTimezone: null,
    completedAt: null,
    createdAt: new Date('2026-11-24T00:00:00Z'),
    updatedAt: new Date('2026-11-24T00:00:00Z'),
    ...overrides,
  });

  it('prazo das colunas novas: due completo, sem o dueDate', () => {
    const at = new Date('2027-01-01T02:59:59Z');
    const item = toTaskListItem(
      row({ dueAt: at, dueTimezone: 'America/Sao_Paulo', dueDate: at }),
    );
    expect(item.due).toEqual({
      at: '2027-01-01T02:59:59.000Z',
      timezone: 'America/Sao_Paulo',
    });
    expect(item).not.toHaveProperty('dueDate');
  });

  it('a due_date (sem uso desde o contract) não é mais lida: a reserva do expand saiu', () => {
    // Só depois do backfill final isto é seguro: nenhuma linha fica só com a coluna antiga
    expect(toTaskListItem(row({ dueDate: new Date() })).due).toBeNull();
  });

  it('sem prazo: due null; e nenhuma coluna interna vaza para a resposta', () => {
    const item = toTaskListItem(row({}));
    expect(item.due).toBeNull();
    for (const column of ['dueAt', 'dueTimezone', 'dueDate']) {
      expect(item).not.toHaveProperty(column);
    }
  });
});

describe('DeprecationNotifier (o mecanismo do ADR-0008, pronto para o próximo campo)', () => {
  const field = {
    name: 'campoAntigo',
    deprecatedAt: new Date('2026-11-24T00:00:00Z'),
    sunsetAt: new Date('2027-03-01T00:00:00Z'),
    link: 'https://example.com/migracao',
  };

  it('headers Deprecation (RFC 9745), Sunset (RFC 8594) e Link rel="deprecation"', () => {
    const headers: Record<string, string> = {};
    const res = {
      setHeader: (k: string, v: string) => (headers[k] = v),
    } as unknown as Response;

    new DeprecationNotifier().fieldUsed(
      res,
      field,
      resolveClientInfo('android', '2.13.0'),
    );

    expect(headers.Deprecation).toBe(`@${Date.UTC(2026, 10, 24) / 1000}`);
    expect(headers.Sunset).toBe('Mon, 01 Mar 2027 00:00:00 GMT');
    expect(headers.Link).toMatch(
      /^<https:\/\/.+>; rel="deprecation"; type="text\/html"$/,
    );
  });
});
