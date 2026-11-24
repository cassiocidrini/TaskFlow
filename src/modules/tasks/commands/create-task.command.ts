/**
 * Comando CQRS: a INTENÇÃO de criar uma tarefa ("quem quer criar o quê, onde").
 *
 * Um command é só dados — não tem comportamento. Quem decide se a intenção é aceita é o
 * {@link CreateTaskHandler} (autorização + regra + persistência).
 *
 * `userId` vem primeiro e é obrigatório: é o ATOR, base da verificação de posse. Ele é preenchido pelo
 * controller a partir do JWT, nunca do body (OWASP A01).
 *
 * Nota de design: este construtor é posicional e anterior à decisão de usar objetos nomeados (adotada nos
 * comandos de ciclo de vida e nos eventos depois que argumentos trocados corromperam um evento). Com vários
 * `string` seguidos, trocar a ordem compila sem erro — o formato `(target, valor)` dos outros comandos evita isso.
 *
 * O prazo chega já no formato novo (Módulo 14.4): o controller converte o `dueDate` antigo em `{ at, timezone: null }`
 * na borda, e daqui para dentro só existe um formato.
 */
export interface DueInput {
  at: Date;
  /** Fuso IANA; `null` quando o cliente usou o formato antigo, que não o informava. */
  timezone: string | null;
}

/** Ver o TSDoc acima: comando posicional, anterior à regra dos objetos nomeados. */
export class CreateTaskCommand {
  constructor(
    public readonly userId: string,
    public readonly projectId: string,
    public readonly title: string,
    public readonly assigneeId?: string,
    public readonly due?: DueInput,
  ) {}
}
