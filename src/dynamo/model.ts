export const keys = {
  user: (userId: string) => ({
    PK: `USER#${userId}`,
    SK: 'PROFILE',
  }),

  project: (userId: string, projectId: string) => ({
    PK: `USER#${userId}`,
    SK: `PROJECT#${projectId}`,
  }),

  task: (projectId: string, createdAt: string, taskId: string) => ({
    PK: `PROJECT#${projectId}`,
    SK: `TASK#${createdAt}#${taskId}`,
  }),
};

export const filters = {
  projectsOfUser: () => ({
    skPrefix: 'PROJECT#',
  }),

  tasksOfProject: () => ({
    skPrefix: 'TASK#',
  }),
};

export const gsiKeys = {
  taskByAssignee: (assigneeId: string, createdAt: string, taskId: string) => ({
    GSI1PK: `USER#${assigneeId}`,
    GSI1SK: `TASK#${createdAt}#${taskId}`,
  }),
};