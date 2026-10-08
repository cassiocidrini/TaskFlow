# stop.ps1
# Para os containers Docker.
# Uso: .\stop.ps1

Write-Host ""
Write-Host "Parando containers..." -ForegroundColor Yellow
docker-compose down
Write-Host "[OK] Containers parados" -ForegroundColor Green
Write-Host ""