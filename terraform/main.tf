# =============================================================================
# TaskFlow — Infraestrutura como Código (Terraform) · Módulo 09
#
# Provisiona os serviços AWS do projeto de forma DECLARATIVA: descreve-se o estado desejado e o Terraform
# calcula o que criar, alterar ou destruir. Por isso o ciclo é sempre `plan` (revisar) → `apply`: remover um
# `resource` deste arquivo DESTRÓI o recurso real no próximo apply.
#
# Alvo atual: LocalStack (AWS emulada em localhost:4566), sem custo. Os recursos são PROVISIONADOS, mas a API
# ainda não os usa — o EventBus do TaskFlow roda em memória; SNS/SQS são a base de um EventBus distribuído.
#
# Arquivos: main.tf (versões, provider, SQS, S3) · sns.tf (SNS + IAM) · backend.tf (onde o state mora).
# =============================================================================

terraform {
  # Mínimo que suporta a sintaxe usada aqui. ATENÇÃO: o lock nativo do state no S3 (`use_lockfile`) exige
  # >= 1.10 — subir este valor faz parte da correção do lock (ver backend.tf).
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source = "hashicorp/aws"
      # "~> 5.0" = qualquer 5.x, nunca 6.0: atualizações de correção sim, breaking changes não.
      # A versão EXATA baixada fica travada no .terraform.lock.hcl (gerado — não editar à mão).
      version = "~> 5.0"
    }
  }
}

# -----------------------------------------------------------------------------
# Provider AWS apontando para o LocalStack.
#
# Credenciais fictícias ("test") que o LocalStack aceita. Na AWS real, NUNCA credenciais no código: elas vêm do
# ambiente (variáveis AWS_*, perfil local) ou de uma role IAM — e o bloco `endpoints` simplesmente some.
# -----------------------------------------------------------------------------
provider "aws" {
  region = "us-east-1"

  access_key = "test"
  secret_key = "test"

  # Validações que consultam a AWS real (STS, metadata da EC2) e falhariam contra o emulador
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true
  # LocalStack endereça buckets pelo caminho (localhost:4566/bucket), não por subdomínio
  s3_use_path_style = true

  # Todos os serviços emulados atendem na mesma porta
  endpoints {
    s3  = "http://localhost:4566"
    sqs = "http://localhost:4566"
    sns = "http://localhost:4566"
    iam = "http://localhost:4566"
  }
}

# -----------------------------------------------------------------------------
# Fila SQS de sincronização — desacopla quem produz trabalho de quem o consome.
#
# - visibility_timeout_seconds = 30: depois que um consumidor pega a mensagem, ela fica INVISÍVEL por 30 s. Se ele
#   não a apagar nesse prazo (travou, caiu), a mensagem volta para a fila e é reentregue. Por isso a entrega é
#   "at-least-once" — e quem consome precisa ser IDEMPOTENTE (o mesmo princípio das projeções do TaskFlow).
#   Regra prática: maior que o tempo de processamento de uma mensagem.
# - message_retention_seconds = 86400: mensagens não consumidas expiram em 1 dia (o padrão da AWS é 4 dias).
#
# Próximo passo natural: uma Dead Letter Queue (redrive_policy) para mensagens que falham repetidamente.
# -----------------------------------------------------------------------------
resource "aws_sqs_queue" "sync_queue" {
  name                       = "taskflow-sync-queue"
  visibility_timeout_seconds = 30
  message_retention_seconds  = 86400 # 1 dia

  # Tags padronizadas em todos os recursos: custo por projeto/ambiente e "quem gerencia isto?" (ManagedBy evita
  # que alguém altere pelo console um recurso que o Terraform vai sobrescrever no próximo apply).
  tags = {
    Environment = "dev"
    Project     = "TaskFlow"
    ManagedBy   = "Terraform"
  }
}

# -----------------------------------------------------------------------------
# Bucket S3 para arquivos (ex.: anexos de tarefas, exportações).
#
# Numa AWS real, o mínimo seria: bloqueio de acesso público (aws_s3_bucket_public_access_block), criptografia em
# repouso e versionamento — recursos separados no provider AWS 5.x. Fora do escopo do laboratório.
# -----------------------------------------------------------------------------
resource "aws_s3_bucket" "taskflow_bucket" {
  bucket = "taskflow-storage-bucket"

  tags = {
    Environment = "dev"
    Project     = "TaskFlow"
    ManagedBy   = "Terraform"
  }
}

# -----------------------------------------------------------------------------
# Outputs: o "contrato" desta infraestrutura com o resto do sistema. Uma aplicação ou outro módulo Terraform
# consome estes valores (URL da fila, ARNs) em vez de copiar strings à mão. Ver com `terraform output`.
# -----------------------------------------------------------------------------
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
