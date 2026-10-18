export class GetTasksQuery {
  constructor(
    public readonly userId: string, // quem está pedindo — base da verificação de posse
    public readonly projectId: string,
    public readonly limit: number,
    public readonly cursor?: string,
  ) {}
}
