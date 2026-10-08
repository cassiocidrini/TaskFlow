# dev.ps1
# Inicia a aplicacao em modo de desenvolvimento.
# Uso: .\dev.ps1

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  TaskFlow - Iniciando desenvolvimento" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

# Verifica se os containers estao rodando
$containers = docker ps --filter "name=taskflow" --format "{{.Names}}"
if (-not $containers) {
    Write-Host "[!] Containers nao estao rodando. Subindo..." -ForegroundColor Yellow
    docker-compose up -d
    Start-Sleep -Seconds 5
}

Write-Host "[OK] Containers rodando" -ForegroundColor Green
Write-Host ""
Write-Host "Iniciando aplicacao..." -ForegroundColor Yellow
Write-Host ""

npm run start:dev