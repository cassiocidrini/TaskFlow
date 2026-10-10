export class TaskCreatedEvent {
  constructor(
    public readonly taskId: string,
    public readonly projectId: string,
    public readonly title: string,
    public readonly assigneeId?: string,
  ) {}
}

export class TaskCompletedEvent {
  constructor(
    public readonly taskId: string,
    public readonly completedAt: string,
  ) {}
}