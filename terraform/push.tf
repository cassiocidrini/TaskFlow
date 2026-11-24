# Envio de push (Módulo 13.7): Kafka para FATOS, SQS para TRABALHO.
#
# O consumer `notifications` grava a notificação (o fato) e enfileira o envio (o trabalho) na fila abaixo, dentro
# da mesma transação. A Lambda `push-sender` consome em lotes, envia uma vez (idempotência no DynamoDB) e devolve só
# as mensagens que falharam (`batchItemFailures`). Depois de 3 recebimentos sem sucesso, a mensagem vai para a DLQ.
#
# Os tempos estão amarrados entre si (mudar um exige conferir os outros):
#   timeout da Lambda (10 s) < prazo da reserva de idempotência (LEASE_SECONDS, 30 s) < visibility timeout (60 s)
# - reserva > Lambda: uma invocação viva nunca perde a reserva para outra;
# - reserva < visibilidade: quando a mensagem de uma invocação que morreu voltar, a reserva já venceu;
# - visibilidade = 6× o timeout da Lambda: a recomendação da AWS para filas com event source mapping, que dá margem
#   ao lote esperar a janela de agrupamento e às tentativas internas do serviço.

locals {
  push_lambda_timeout_seconds = 10
  push_lease_seconds          = 30
  push_tags = {
    Environment = "dev"
    Project     = "TaskFlow"
    ManagedBy   = "Terraform"
  }
}

# DLQ: onde o push que falhou 3 vezes espera alguém olhar. Retenção máxima do SQS (14 dias), maior que a da fila de
# origem: a mensagem conserva o timestamp de envio original, e com retenção menor ou igual ela expiraria ao chegar.
resource "aws_sqs_queue" "push_dlq" {
  name                      = "taskflow-push-dlq"
  message_retention_seconds = 1209600 # 14 dias
  tags                      = local.push_tags
}

# Fila STANDARD, não FIFO: a ordem dos pushes não importa, e a idempotência está na Lambda. A FIFO limitaria a vazão e
# só deduplica numa janela de 5 minutos, o que não substitui a idempotência (a duplicata do consumer pode vir depois).
resource "aws_sqs_queue" "push" {
  name                       = "taskflow-push"
  visibility_timeout_seconds = local.push_lambda_timeout_seconds * 6
  message_retention_seconds  = 86400 # 1 dia: um push de "você foi atribuído" com mais de um dia já não ajuda ninguém
  receive_wait_time_seconds  = 20    # long polling: menos chamadas vazias (a Lambda já faz isso; vale para inspeção manual)

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.push_dlq.arn
    maxReceiveCount     = 3
  })

  tags = local.push_tags
}

# Só a fila de push pode usar esta DLQ (evita outra fila mandar mensagens para cá por engano).
resource "aws_sqs_queue_redrive_allow_policy" "push_dlq" {
  queue_url = aws_sqs_queue.push_dlq.id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.push.arn]
  })
}

# Idempotência do envio: um item por push (`pushId` = eventId do evento de origem). On-demand: paga por requisição,
# sem capacidade para planejar num volume baixo e irregular. O TTL apaga sozinho o que passou de `expiresAt`
# (epoch em segundos), sem custo de escrita: é a "limpeza" que no Postgres precisou de um job (processed_events).
resource "aws_dynamodb_table" "push_deliveries" {
  name         = "taskflow-push-deliveries"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pushId"

  attribute {
    name = "pushId"
    type = "S"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  tags = local.push_tags
}

# O pacote da Lambda: só o JavaScript compilado (`npm run lambda:build`). O SDK do DynamoDB já vem no runtime.
data "archive_file" "push_sender" {
  type        = "zip"
  source_dir  = "${path.module}/../lambdas/push-sender/dist"
  output_path = "${path.module}/.build/push-sender.zip"
}

resource "aws_iam_role" "push_sender" {
  name = "taskflow-push-sender-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })

  tags = local.push_tags
}

# Menor privilégio: só ESTA fila e ESTA tabela, só as ações que o código usa. Sem `dynamodb:*` nem `Resource = "*"`
# (exceto logs, cujo grupo é criado pelo serviço).
resource "aws_iam_role_policy" "push_sender" {
  name = "taskflow-push-sender-policy"
  role = aws_iam_role.push_sender.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
        Resource = aws_sqs_queue.push.arn
      },
      {
        Effect   = "Allow"
        Action   = ["dynamodb:PutItem", "dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"]
        Resource = aws_dynamodb_table.push_deliveries.arn
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "*"
      }
    ]
  })
}

# Runtime nodejs22.x: o provider AWS travado no lock (5.100) ainda não aceita o nodejs24.x. A Lambda é outro
# deployable, com runtime próprio; o código dela não usa nada que exija o Node 24 da API.
resource "aws_lambda_function" "push_sender" {
  function_name    = "taskflow-push-sender"
  role             = aws_iam_role.push_sender.arn
  runtime          = "nodejs22.x"
  handler          = "handler.handler"
  filename         = data.archive_file.push_sender.output_path
  source_code_hash = data.archive_file.push_sender.output_base64sha256 # código mudou → nova versão publicada
  timeout          = local.push_lambda_timeout_seconds
  memory_size      = 128

  environment {
    variables = {
      IDEMPOTENCY_TABLE = aws_dynamodb_table.push_deliveries.name
      LEASE_SECONDS     = tostring(local.push_lease_seconds)
      RETENTION_HOURS   = "48" # > retenção da fila (1 dia): uma reentrega nunca chega depois do COMPLETED expirar
    }
  }

  tags = local.push_tags
}

resource "aws_lambda_event_source_mapping" "push_sender" {
  event_source_arn                   = aws_sqs_queue.push.arn
  function_name                      = aws_lambda_function.push_sender.arn
  batch_size                         = 10
  maximum_batching_window_in_seconds = 1 # espera até 1 s para encher o lote: menos invocações, latência aceitável
  # Sem isto, a resposta `batchItemFailures` é IGNORADA e uma mensagem ruim devolve o lote inteiro
  function_response_types = ["ReportBatchItemFailures"]

  # Teto de invocações simultâneas lendo a fila: protege o provedor de push (e a cota dele) de um pico na fila
  scaling_config {
    maximum_concurrency = 2
  }
}

output "push_queue_url" {
  value       = aws_sqs_queue.push.id
  description = "URL da fila de push: vai em PUSH_QUEUE_URL do consumer de notificações"
}

output "push_dlq_url" {
  value       = aws_sqs_queue.push_dlq.id
  description = "URL da DLQ do push"
}
