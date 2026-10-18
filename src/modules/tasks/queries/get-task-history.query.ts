import type { TaskCommandTarget } from '../commands/task-command.runner';

export class GetTaskHistoryQuery {
  constructor(public readonly target: TaskCommandTarget) {}
}
