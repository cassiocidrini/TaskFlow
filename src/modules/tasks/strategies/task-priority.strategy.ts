/**
 * Strategy Pattern: uma família de algoritmos de prioridade intercambiáveis atrás de um único contrato.
 *
 * Problema que resolve: várias formas de calcular a mesma coisa sem uma cadeia de `if/else` crescendo no
 * handler. Uma regra nova (ex.: prioridade por cliente VIP) vira uma classe nova — o handler não muda
 * (princípio aberto/fechado).
 *
 * Retorna a união literal `'LOW' | 'MEDIUM' | 'HIGH'`, estruturalmente igual ao `TaskPriority` do domínio e ao
 * enum `TaskPriority` do Prisma — o mesmo valor atravessa evento, agregado e Read Model sem conversão.
 *
 * **Status (honesto):** a interface e as implementações estão corretas, mas a composição é parcial — o
 * `CreateTaskHandler` instancia a `KeywordPriorityStrategy` com `new` e a {@link DeadlinePriorityStrategy}
 * ainda não é usada. Ver Módulo 12 (docs/modules/12-design-patterns.md).
 */
export interface TaskPriorityStrategy {
  calculate(title: string, dueDate?: Date): 'LOW' | 'MEDIUM' | 'HIGH';
}

/**
 * Prioridade por palavras-chave no título — a estratégia em uso.
 *
 * Regra de negócio no SERVIDOR (e não enviada pelo cliente): todos os clientes recebem a mesma prioridade
 * para o mesmo título, e ninguém consegue "furar a fila" enviando `priority: HIGH`.
 *
 * Limitação: a comparação é sensível a acento — "critico" (sem acento) não casa com `'crítico'`.
 * Normalizar o texto (remover diacríticos antes de comparar) tornaria a regra mais robusta.
 */
export class KeywordPriorityStrategy implements TaskPriorityStrategy {
  calculate(title: string, _dueDate?: Date): 'LOW' | 'MEDIUM' | 'HIGH' {
    const urgentKeywords = ['urgente', 'bug', 'crítico'];
    const isUrgent = urgentKeywords.some(kw => title.toLowerCase().includes(kw));
    return isUrgent ? 'HIGH' : 'MEDIUM';
  }
}

/**
 * Prioridade pela proximidade do prazo: ≤ 1 dia → HIGH, ≤ 3 dias → MEDIUM, senão (ou sem prazo) → LOW.
 *
 * Implementada, mas SEM USO e sem teste próprio — está aqui como a segunda estratégia que justificaria a
 * troca em runtime. Um próximo passo natural é combiná-las (ex.: a maior das duas prioridades).
 *
 * Usa `Date.now()` internamente: para testá-la de forma determinística, o "agora" deveria ser injetado,
 * como o agregado faz em `complete(now)`.
 */
export class DeadlinePriorityStrategy implements TaskPriorityStrategy {
  calculate(_title: string, dueDate?: Date): 'LOW' | 'MEDIUM' | 'HIGH' {
    if (!dueDate) return 'LOW';
    const daysUntilDue = Math.ceil((dueDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    if (daysUntilDue <= 1) return 'HIGH';
    if (daysUntilDue <= 3) return 'MEDIUM';
    return 'LOW';
  }
}
