export class CreateTaskCommand {
  constructor(
    public readonly userId: string, // quem está pedindo — base da verificação de posse
    public readonly projectId: string,
    public readonly title: string,
    public readonly assigneeId?: string,
    public readonly dueDate?: Date,
  ) {}
}
