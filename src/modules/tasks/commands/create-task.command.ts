export class CreateTaskCommand {
  constructor(
    public readonly projectId: string,
    public readonly title: string,
    public readonly assigneeId?: string,
    public readonly dueDate?: Date,
  ) {}
}