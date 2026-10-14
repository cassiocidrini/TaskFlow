# terraform-recreate.ps1
# Limpa e recria toda a infraestrutura Terraform + LocalStack
# Uso: .\terraform-recreate.ps1

Write-Host ""
Write-Host "============================================================" -ForegroundColor Magenta
Write-Host "  RECRIANDO AMBIENTE COMPLETO" -ForegroundColor Magenta
Write-Host "============================================================" -ForegroundColor Magenta
Write-Host ""

& "$PSScriptRoot\terraform-clean.ps1"
if ($LASTEXITCODE -ne 0) {
    Write-Host "[X] Falha na limpeza. Abortando." -ForegroundColor Red
    exit 1
}

Start-Sleep -Seconds 2

& "$PSScriptRoot\terraform-setup.ps1"