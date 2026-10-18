// 1. Interface
export interface TaskPriorityStrategy {
  calculate(title: string, dueDate?: Date): 'LOW' | 'MEDIUM' | 'HIGH';
}

// 2. Estratégia 1: Prioriza baseado em palavras-chave no título
export class KeywordPriorityStrategy implements TaskPriorityStrategy {
  calculate(title: string, _dueDate?: Date): 'LOW' | 'MEDIUM' | 'HIGH' {
    const urgentKeywords = ['urgente', 'bug', 'crítico'];
    const isUrgent = urgentKeywords.some(kw => title.toLowerCase().includes(kw));
    return isUrgent ? 'HIGH' : 'MEDIUM';
  }
}

// 3. Estratégia 2: Prioriza baseado na proximidade da data de vencimento
export class DeadlinePriorityStrategy implements TaskPriorityStrategy {
  calculate(_title: string, dueDate?: Date): 'LOW' | 'MEDIUM' | 'HIGH' {
    if (!dueDate) return 'LOW';
    const daysUntilDue = Math.ceil((dueDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    if (daysUntilDue <= 1) return 'HIGH';
    if (daysUntilDue <= 3) return 'MEDIUM';
    return 'LOW';
  }
}