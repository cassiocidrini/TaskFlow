# =============================================================================
# Backend remoto: onde o STATE do Terraform mora.
#
# O state (terraform.tfstate) é o mapa entre este código e os recursos reais (IDs, ARNs, dependências). Sem ele,
# o Terraform não sabe o que já existe. Guardá-lo num backend remoto (S3), e não na máquina de alguém, serve para:
#   1. COMPARTILHAR — todo mundo (e o CI) trabalha sobre o mesmo state;
#   2. GUARDAR com segurança — o state pode conter segredos e não deve ir para o Git (ver .gitignore);
#   3. TRAVAR (lock) — impedir dois `apply` simultâneos, que corromperiam o state.
#
# ⚠️ LIMITAÇÃO CONHECIDA: o item 3 NÃO está configurado. Falta `use_lockfile = true` (lock nativo do S3, que
#    substituiu a antiga tabela DynamoDB `dynamodb_table`) e, junto, `required_version = ">= 1.10.0"` no main.tf.
#    Hoje este backend compartilha e guarda o state, mas não impede corridas. Ver Módulo 09.
#
# O bucket do state é criado ANTES do `terraform init` pelo terraform-setup.ps1: o Terraform não pode criar o
# lugar onde guardará o próprio state.
# =============================================================================
terraform {
  backend "s3" {
    bucket = "taskflow-terraform-state"
    key    = "taskflow/terraform.tfstate"
    region = "us-east-1"

    # O backend NÃO herda nada do bloco `provider "aws"`: endpoint, credenciais e flags `skip_*` precisam ser
    # repetidos aqui. Esquecer isso gerava `InvalidClientTokenId` (problema nº 4 do Módulo 09).
    endpoints = {
      s3 = "http://localhost:4566"
    }

    # Credenciais fictícias do LocalStack — na AWS real, vindas do ambiente, nunca do código
    access_key = "test"
    secret_key = "test"

    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true

    # Renomeado de `force_path_style` no Terraform 1.6+ (problema nº 5 do Módulo 09)
    use_path_style = true
  }
}
