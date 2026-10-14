terraform {
  backend "s3" {
    bucket = "taskflow-terraform-state"
    key    = "taskflow/terraform.tfstate"
    region = "us-east-1"

    # LocalStack: aponta o backend para o endpoint local
    endpoints = {
      s3 = "http://localhost:4566"
    }

    # LocalStack: credenciais fake
    access_key = "test"
    secret_key = "test"

    # LocalStack: desabilita validações que não funcionam
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true

    # LocalStack: usa path style (obrigatório)
    use_path_style = true
  }
}