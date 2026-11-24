/**
 * O pedido de push como a Lambda o LÊ (Módulo 13.7). Cópia própria do contrato, como os consumers do Kafka fazem com
 * o evento de integração: a Lambda é outro deployable e não importa código do consumer de notificações. Se o
 * produtor mudar o formato sem mudar a `version`, quem acusa é esta validação, não um `undefined` no meio do envio.
 *
 * Validação à mão, sem zod, de propósito: o pacote da Lambda leva só o código compilado, e o runtime já traz o SDK
 * da AWS, mas não o zod. Uma dependência a mais exigiria bundler para um contrato de 8 campos.
 */

export interface PushRequest {
  pushId: string;
  userId: string;
  type: string;
  body: string;
  taskId: string;
  projectId: string;
  requestedAt: string;
}

/** Versões que esta Lambda sabe ler. Versão nova do produtor entra aqui ANTES de ser enviada (tolerant reader). */
const SUPPORTED_VERSIONS = new Set([1]);

/** Corpo que nenhuma nova tentativa vai consertar: a mensagem acaba na DLQ depois do `maxReceiveCount`. */
export class InvalidPushRequestError extends Error {}

const REQUIRED_STRINGS = [
  'pushId',
  'userId',
  'type',
  'body',
  'taskId',
  'projectId',
  'requestedAt',
] as const;

export function parsePushRequest(raw: string): PushRequest {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new InvalidPushRequestError('corpo não é JSON');
  }
  if (typeof value !== 'object' || value === null) {
    throw new InvalidPushRequestError('corpo não é um objeto');
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.version !== 'number' ||
    !SUPPORTED_VERSIONS.has(record.version)
  ) {
    throw new InvalidPushRequestError(
      `versão não suportada: ${String(record.version)}`,
    );
  }
  for (const field of REQUIRED_STRINGS) {
    if (typeof record[field] !== 'string' || record[field] === '') {
      throw new InvalidPushRequestError(`campo ausente ou inválido: ${field}`);
    }
  }
  // Campo a campo: o que vier a mais no corpo é ignorado, não repassado
  return {
    pushId: record.pushId as string,
    userId: record.userId as string,
    type: record.type as string,
    body: record.body as string,
    taskId: record.taskId as string,
    projectId: record.projectId as string,
    requestedAt: record.requestedAt as string,
  };
}
