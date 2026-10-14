# terraform-clean.ps1
# Limpa toda a infraestrutura Terraform + LocalStack
# Uso: .\terraform-clean.ps1
#
# ATENÇÃO: isso remove:
#   - Recursos criados pelo Terraform (S3, SQS, RDS)
#   - State local (.tfstate, .terraform/)
#   - Container LocalStack
#   - Volume de dados do LocalStack (perde dados do DynamoDB, SQS, etc)

$ErrorActionPreference = "Continue"
$terraformDir = Join-Path $PSScriptRoot "terraform"

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  Terraform + LocalStack - LIMPEZA" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

# ------------------------------------------------------------------
# 1. Destroi os recursos gerenciados pelo Terraform
# ------------------------------------------------------------------
Write-Host "[1/5] Destruindo recursos Terraform..." -ForegroundColor Yellow

if (Test-Path "$terraformDir\terraform.tfstate") {
    Push-Location $terraformDir
    try {
        terraform destroy -auto-approve 2>&1 | Out-Null
        Write-Host "      [OK] Recursos destruidos" -ForegroundColor Green
    } catch {
        Write-Host "      [!] Falha no destroy (state pode estar inconsistente)" -ForegroundColor Yellow
        Write-Host "      Continuando a limpeza..." -ForegroundColor DarkGray
    }
    Pop-Location
} else {
    Write-Host "      [i] Nenhum state local. Pulando destroy." -ForegroundColor DarkGray
}

# ------------------------------------------------------------------
# 2. Remove arquivos locais do Terraform
# ------------------------------------------------------------------
Write-Host "[2/5] Removendo arquivos locais do Terraform..." -ForegroundColor Yellow

Remove-Item -Path "$terraformDir\terraform.tfstate" -Force -ErrorAction SilentlyContinue
Remove-Item -Path "$terraformDir\terraform.tfstate.backup" -Force -ErrorAction SilentlyContinue
Remove-Item -Path "$terraformDir\.terraform" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path "$terraformDir\.terraform.lock.hcl" -Force -ErrorAction SilentlyContinue
Remove-Item -Path "$terraformDir\backend.conf" -Force -ErrorAction SilentlyContinue

Write-Host "      [OK] State, providers e configs removidos" -ForegroundColor Green

# ------------------------------------------------------------------
# 3. Para o container LocalStack
# ------------------------------------------------------------------
Write-Host "[3/5] Parando LocalStack..." -ForegroundColor Yellow

docker stop taskflow-localstack 2>&1 | Out-Null
Write-Host "      [OK] Container parado" -ForegroundColor Green

# ------------------------------------------------------------------
# 4. Remove o container LocalStack
# ------------------------------------------------------------------
Write-Host "[4/5] Removendo container LocalStack..." -ForegroundColor Yellow

docker rm taskflow-localstack 2>&1 | Out-Null
Write-Host "      [OK] Container removido" -ForegroundColor Green

# ------------------------------------------------------------------
# 5. Remove o volume de dados do LocalStack
# ------------------------------------------------------------------
Write-Host "[5/5] Removendo volume de dados do LocalStack..." -ForegroundColor Yellow

docker volume rm taskflow_localstack_data 2>&1 | Out-Null
Write-Host "      [OK] Volume removido (dados do DynamoDB/SQS foram perdidos)" -ForegroundColor Green

Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  [OK] Limpeza completa!" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Para recriar tudo, rode:" -ForegroundColor Cyan
Write-Host "   .\terraform-setup.ps1" -ForegroundColor White
Write-Host ""