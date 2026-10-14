# ============================================================
# Bloco terraform: define a versão do Terraform e do provider
# ============================================================
terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

# ============================================================
# Provider AWS — apontando para o LocalStack
# ============================================================
provider "aws" {
  region = "us-east-1"

  # Credenciais "fake" — LocalStack aceita qualquer valor
  access_key = "test"
  secret_key = "test"

  # Desabilita validações que não funcionam com LocalStack
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true
  s3_use_path_style           = true

  # Endpoints do LocalStack (todos na mesma porta)
    endpoints {
        s3  = "http://localhost:4566"
        sqs = "http://localhost:4566"
        sns = "http://localhost:4566"
        iam = "http://localhost:4566"
    }
}

# ============================================================
# Recurso: Fila SQS para sincronização
# ============================================================
resource "aws_sqs_queue" "sync_queue" {
  name                       = "taskflow-sync-queue"
  visibility_timeout_seconds = 30
  message_retention_seconds  = 86400  # 1 dia

  tags = {
    Environment = "dev"
    Project     = "TaskFlow"
    ManagedBy   = "Terraform"
  }
}

# ============================================================
# Recurso: Bucket S3 para armazenamento de arquivos
# ============================================================
resource "aws_s3_bucket" "taskflow_bucket" {
  bucket = "taskflow-storage-bucket"

  tags = {
    Environment = "dev"
    Project     = "TaskFlow"
    ManagedBy   = "Terraform"
  }
}

# ============================================================
# Outputs: valores úteis para outras partes do sistema
# ============================================================
output "sqs_queue_url" {
  value       = aws_sqs_queue.sync_queue.id
  description = "URL da fila SQS de sincronização"
}

output "sqs_queue_arn" {
  value       = aws_sqs_queue.sync_queue.arn
  description = "ARN da fila SQS"
}

output "s3_bucket_name" {
  value       = aws_s3_bucket.taskflow_bucket.bucket
  description = "Nome do bucket S3"
}

output "s3_bucket_arn" {
  value       = aws_s3_bucket.taskflow_bucket.arn
  description = "ARN do bucket S3"
}