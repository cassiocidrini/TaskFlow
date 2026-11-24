# ADR-0009: Idempotência de requisições na mesma transação do efeito

- **Status:** Aceito
- **Decisão:** 24/11/2026 (Módulo 14.5) · **Registro:** 24/11/2026
- **Relacionados:** [ADR-0002](0002-transactional-outbox-com-relay-por-polling.md) (o mesmo princípio para publicar
  eventos) · [ADR-0005](0005-idempotencia-no-consumer.md) (o mesmo princípio do lado do consumer)

## Contexto

O app manda `POST /tasks`, o servidor cria a tarefa, e a resposta se perde (túnel, troca de rede, timeout). O app não
sabe se deu certo e repete; o usuário fica com duas tarefas. Numa fintech, o mesmo cenário é uma transferência dupla.

O cliente precisa de um jeito de dizer "esta é a MESMA intenção de antes", e o servidor, de garantir que a mesma
intenção produz o efeito uma vez só, devolvendo a mesma resposta a cada nova tentativa. O padrão de mercado é o header
`Idempotency-Key` (Stripe, Adyen, e o rascunho do IETF *draft-ietf-httpapi-idempotency-key-header*).

## Decisão

**A chave é gravada NA MESMA transação do efeito**, e a chave primária decide a corrida:

1. o cliente gera um UUID por intenção e o manda em `Idempotency-Key` (opcional: exigi-lo quebraria os apps
   instalados);
2. a API busca a chave do usuário: se existe e o pedido é o mesmo (hash SHA-256 de método + rota + corpo, serializado
   de forma estável), devolve a resposta guardada com `Idempotent-Replayed: true`; se o pedido é outro, **422**
   `IDEMPOTENCY_KEY_REUSED`;
3. se não existe, executa: a linha da chave (com a resposta) é mais um INSERT da transação do `TaskCreated`, junto com
   o evento e a outbox (o gancho `alsoWrite` do Event Store);
4. duas tentativas simultâneas: a chave primária `(user_id, key)` deixa uma só; a outra transação é desfeita inteira (a
   tarefa dela não existe), e ela busca de novo e devolve a resposta da vencedora.

Também: a chave vale **por usuário**; só o **sucesso** é guardado (uma criação que falhou não aconteceu, e pode ser
tentada de novo); validade de **24 h**, com limpeza periódica em lotes.

## Alternativas consideradas

| Alternativa | Por que não |
|---|---|
| **Reservar → executar → marcar** (`IN_PROGRESS` → `COMPLETED`) | Dual-write: um crash entre criar a tarefa e marcar a chave a deixa presa. Com prazo na reserva, a tentativa seguinte cria uma SEGUNDA tarefa; sem prazo, a chave trava para sempre. Exige um estado a mais e um job para reservas órfãs |
| **Cache externo** (Redis com `SET NX`) | Mesmo dual-write, agora entre dois sistemas: o Redis e o Postgres não compartilham transação |
| **Chave global** (não por usuário) | Um usuário que adivinhasse a chave de outro receberia a resposta guardada dele (OWASP A01) |
| **Guardar também os erros** | Uma criação que falhou não teve efeito; repetir a mesma resposta de erro impediria a nova tentativa depois de o problema ser corrigido. O Stripe também não guarda o que não chegou a executar |
| **Deduplicar pelo conteúdo** (sem chave) | Dois pedidos iguais podem ser duas intenções legítimas (duas transferências de R$ 100 para a mesma pessoa). Só o cliente sabe se é a mesma |
| **Interpretar o nome da constraint no erro do Prisma** para separar "chave repetida" de "conflito de versão" | Frágil entre versões do Prisma. Consultar a tabela de novo depois do conflito é estável, e um conflito de versão num agregado NOVO exigiria dois UUIDs aleatórios iguais |

## Consequências

**Positivas**
- Sem estado intermediário, sem reserva presa, sem job de recuperação: ou a tarefa existe e a chave está registrada,
  ou nenhuma das duas.
- A corrida é resolvida pelo banco, sem lock explícito.
- O mesmo princípio do resto do sistema (outbox, `processed_events`): marca e efeito na mesma transação.

**Negativas**
- **Só funciona quando o efeito é uma transação no MESMO banco.** Um efeito externo (cobrar num gateway) exigiria a
  reserva com prazo e a chave repassada ao sistema externo.
- **A segunda tentativa simultânea espera a primeira terminar** (o INSERT espera o lock da chave primária): a latência
  dela é a da primeira.
- **Uma linha por requisição com chave**, por 24 h. O job de limpeza mantém a tabela limitada.
- **Só o `POST /tasks` tem a chave hoje.** Os comandos de ciclo de vida não DUPLICAM efeito numa nova tentativa, pela
  regra de domínio: atribuir ao mesmo responsável ou repetir o status não geram evento; concluir de novo responde 409,
  sem efeito. Mas a resposta da nova tentativa pode ser diferente (o 409), o que a chave resolveria. Outro endpoint de
  criação segue a mesma receita.

## Revisitar quando

- **Um endpoint com efeito fora do Postgres** (pagamento, e-mail): reserva com prazo + a chave repassada ao sistema
  externo, que também precisa ser idempotente.
- **Volume alto de chaves:** particionar a tabela por data (a limpeza vira `DROP PARTITION`).
- **O header passar a ser obrigatório** (numa versão mínima de app que sempre o manda): exigi-lo em todo `POST`.

## Evidência

- 10 requisições simultâneas com a mesma chave: uma tarefa, um evento, uma mensagem na outbox, uma chave, e o mesmo
  `taskId` nas 10 respostas (3 execuções estáveis). **Mutação:** com a chave gravada depois, numa transação separada,
  o teste falha. E a chave que não pôde ser gravada desfaz também a tarefa:
  [`idempotency.spec.ts`](../../test/integration/idempotency.spec.ts).
- Via HTTP: a nova tentativa com o mesmo `taskId` e `Idempotent-Replayed`, 422 com outro pedido, 400 com chave
  inválida, nada guardado numa criação que falhou: [`idempotency.e2e-spec.ts`](../../test/e2e/idempotency.e2e-spec.ts).
- Detalhes: [Módulo 14](../modules/14-api-para-web-e-apps.md), "Idempotency-Key (14.5)".
