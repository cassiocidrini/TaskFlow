# =============================================================================
# Mensageria (SNS) e identidade (IAM) para uma futura Lambda de sincronização.
# =============================================================================

# -----------------------------------------------------------------------------
# Tópico SNS — pub/sub: UM evento publicado, N assinantes (filas, Lambdas, e-mail).
#
# É o equivalente distribuído do EventBus em memória do TaskFlow (padrão Observer): hoje um `TaskCompleted` é
# entregue às projeções dentro do mesmo processo; com SNS (+ uma fila SQS por assinante), seria entregue a outros
# serviços. Nesse cenário a entrega é at-least-once e pode vir fora de ordem — as projeções precisariam guardar
# a versão do agregado (limitação documentada no Módulo 05).
# -----------------------------------------------------------------------------
resource "aws_sns_topic" "taskflow_events" {
  name = "taskflow-events"

  tags = {
    Environment = "dev"
    Project     = "TaskFlow"
    ManagedBy   = "Terraform"
  }
}

# -----------------------------------------------------------------------------
# Role IAM da Lambda de sincronização.
#
# A "trust policy" (assume_role_policy) responde QUEM pode vestir esta identidade: só o serviço Lambda. Ela não
# concede permissão nenhuma por si só — as permissões vêm da policy abaixo. Separar as duas coisas é o modelo do
# IAM: identidade de um lado, autorização do outro.
# -----------------------------------------------------------------------------
resource "aws_iam_role" "lambda_sync_role" {
  name = "taskflow-lambda-sync-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })

  tags = {
    Environment = "dev"
    Project     = "TaskFlow"
    ManagedBy   = "Terraform"
  }
}

# -----------------------------------------------------------------------------
# Permissões da Lambda — PRINCÍPIO DO MENOR PRIVILÉGIO (OWASP A01 aplicado à infraestrutura).
#
# Ações ESPECÍFICAS (e não `sqs:*` / `s3:*`) sobre recursos ESPECÍFICOS (os ARNs desta fila e deste bucket, e não
# `"*"`). Se a Lambda for comprometida, o estrago fica limitado a ler/apagar mensagens de UMA fila e ler/gravar
# objetos de UM bucket. Os ARNs vêm das referências aos recursos — se um nome mudar, a policy acompanha.
#
# A única exceção, `Resource = "*"` nos logs, é o padrão aceito: a Lambda cria o próprio log group, cujo ARN não
# existe antes da primeira execução.
# -----------------------------------------------------------------------------
resource "aws_iam_policy" "lambda_sync_policy" {
  name        = "taskflow-lambda-sync-policy"
  description = "Permissoes para a Lambda de sincronizacao"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Consumir a fila: receber, apagar após processar (senão a mensagem volta) e ler atributos
        Effect = "Allow"
        Action = [
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes"
        ]
        Resource = aws_sqs_queue.sync_queue.arn
      },
      {
        # Objetos do bucket (o "/*" é obrigatório: ações de objeto se aplicam aos itens, não ao bucket em si)
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject"
        ]
        Resource = "${aws_s3_bucket.taskflow_bucket.arn}/*"
      },
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "*"
      }
    ]
  })
}

# Liga a policy à role. Recurso separado (e não `inline_policy`) para a mesma policy poder ser reutilizada e
# versionada de forma independente.
resource "aws_iam_role_policy_attachment" "lambda_sync_attachment" {
  role       = aws_iam_role.lambda_sync_role.name
  policy_arn = aws_iam_policy.lambda_sync_policy.arn
}

output "sns_topic_arn" {
  value       = aws_sns_topic.taskflow_events.arn
  description = "ARN do topico SNS"
}

output "lambda_role_arn" {
  value       = aws_iam_role.lambda_sync_role.arn
  description = "ARN da role IAM da Lambda"
}
