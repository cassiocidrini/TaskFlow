# ============================================================
# SNS Topic — para notificações de eventos do TaskFlow
# ============================================================
resource "aws_sns_topic" "taskflow_events" {
  name = "taskflow-events"

  tags = {
    Environment = "dev"
    Project     = "TaskFlow"
    ManagedBy   = "Terraform"
  }
}

# ============================================================
# IAM Role — para a Lambda de sincronização
# ============================================================
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

# ============================================================
# IAM Policy — permissões que a Lambda precisa
# ============================================================
resource "aws_iam_policy" "lambda_sync_policy" {
  name        = "taskflow-lambda-sync-policy"
  description = "Permissoes para a Lambda de sincronizacao"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes"
        ]
        Resource = aws_sqs_queue.sync_queue.arn
      },
      {
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

# ============================================================
# Anexar a policy à role
# ============================================================
resource "aws_iam_role_policy_attachment" "lambda_sync_attachment" {
  role       = aws_iam_role.lambda_sync_role.name
  policy_arn = aws_iam_policy.lambda_sync_policy.arn
}

# ============================================================
# Outputs
# ============================================================
output "sns_topic_arn" {
  value       = aws_sns_topic.taskflow_events.arn
  description = "ARN do topico SNS"
}

output "lambda_role_arn" {
  value       = aws_iam_role.lambda_sync_role.arn
  description = "ARN da role IAM da Lambda"
}