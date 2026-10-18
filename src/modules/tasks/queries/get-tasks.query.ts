/**
 * Query CQRS: listar as tarefas de um projeto, paginadas por cursor.
 *
 * Queries não alteram estado — por isso podem ler de um modelo otimizado para leitura (o Read Model
 * `tasks_read`), independente do modelo de escrita (o Event Store).
 *
 * Carrega o `userId` mesmo sendo leitura: ler tarefas de um projeto alheio também é Broken Access Control
 * (OWASP A01), então a query passa pela mesma verificação de posse que os comandos.
 */
export class GetTasksQuery {
  constructor(
    public readonly userId: string,
    public readonly projectId: string,
    /** Já validado (1–100) pelo `CursorPaginationDto`: o teto é imposto pelo servidor (OWASP API4). */
    public readonly limit: number,
    public readonly cursor?: string,
  ) {}
}
