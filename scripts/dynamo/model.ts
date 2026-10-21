/**
 * Geração CENTRALIZADA das chaves do Single-Table Design (laboratório do Módulo 04).
 *
 * Query-first design: as chaves foram desenhadas a partir dos padrões de acesso (AP1–AP4), não das entidades.
 * Centralizar evita o bug clássico de um script gravar `USER#u1` e outro buscar `USER-u1`. O `#` é só
 * convenção de leitura — sem significado para o DynamoDB.
 *
 * | Entidade | PK            | SK                            |
 * |----------|---------------|-------------------------------|
 * | User     | `USER#<id>`   | `PROFILE`                     |
 * | Project  | `USER#<id>`   | `PROJECT#<id>`                |
 * | Task     | `PROJECT#<id>`| `TASK#<createdAt>#<taskId>`   |
 */
export const keys = {
  user: (userId: string) => ({
    PK: `USER#${userId}`,
    SK: 'PROFILE',
  }),

  project: (userId: string, projectId: string) => ({
    PK: `USER#${userId}`,
    SK: `PROJECT#${projectId}`,
  }),

  /**
   * `createdAt` PRIMEIRO na Sort Key: os itens da partição ficam em ordem cronológica, o que dá de graça a
   * ordenação (sem `ORDER BY`), range queries por data e "as N mais recentes" (`Limit` + `ScanIndexForward:
   * false`). O `taskId` no fim desempata tarefas criadas no mesmo instante.
   */
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

/**
 * Chaves do GSI1 — o segundo padrão de acesso (AP4: tarefas de um responsável).
 * A chave principal das tarefas é `PROJECT#…`, mas a pergunta é por `USER#…`: o GSI "reordena" os mesmos itens
 * por outra chave, sem duplicá-los na tabela (o DynamoDB mantém o índice sozinho, ao custo de escrita extra).
 */
export const gsiKeys = {
  taskByAssignee: (assigneeId: string, createdAt: string, taskId: string) => ({
    GSI1PK: `USER#${assigneeId}`,
    GSI1SK: `TASK#${createdAt}#${taskId}`,
  }),
};