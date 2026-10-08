# setup.ps1
# Script de setup completo do projeto TaskFlow.
# Uso: .\setup.ps1

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  TaskFlow - Setup Completo" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

# 1. Verificar pré-requisitos
Write-Host "[1/5] Verificando pre-requisitos..." -ForegroundColor Yellow

try {
    $nodeVersion = node --version
    Write-Host "  [OK] Node.js $nodeVersion" -ForegroundColor Green
} catch {
    Write-Host "  [X] Node.js nao encontrado. Instale em https://nodejs.org/" -ForegroundColor Red
    exit 1
}

try {
    $dockerVersion = docker --version
    Write-Host "  [OK] $dockerVersion" -ForegroundColor Green
} catch {
    Write-Host "  [X] Docker nao encontrado. Instale o Docker Desktop." -ForegroundColor Red
    exit 1
}

# Verifica se o Docker daemon esta rodando
try {
    docker ps | Out-Null
    Write-Host "  [OK] Docker daemon esta rodando" -ForegroundColor Green
} catch {
    Write-Host "  [X] Docker daemon nao esta rodando. Abra o Docker Desktop." -ForegroundColor Red
    exit 1
}

# 2. Verificar .env
Write-Host ""
Write-Host "[2/5] Verificando arquivo .env..." -ForegroundColor Yellow

if (-not (Test-Path ".env")) {
    if (Test-Path ".env.example") {
        Copy-Item ".env.example" ".env"
        Write-Host "  [OK] .env criado a partir de .env.example" -ForegroundColor Green
    } else {
        Write-Host "  [!] .env nao encontrado. Criando com valores padrao..." -ForegroundColor Yellow
        @'
DATABASE_URL="postgresql://taskflow:taskflow123@localhost:5432/taskflow_db?schema=public"
'@ | Out-File -FilePath ".env" -Encoding utf8
        Write-Host "  [OK] .env criado" -ForegroundColor Green
    }
} else {
    Write-Host "  [OK] .env ja existe" -ForegroundColor Green
}

# 3. Instalar dependencias npm
Write-Host ""
Write-Host "[3/5] Instalando dependencias npm..." -ForegroundColor Yellow
npm install
if ($LASTEXITCODE -ne 0) {
    Write-Host "  [X] Falha no npm install" -ForegroundColor Red
    exit 1
}
Write-Host "  [OK] Dependencias instaladas" -ForegroundColor Green

# 4. Subir containers Docker
Write-Host ""
Write-Host "[4/5] Subindo containers Docker..." -ForegroundColor Yellow
docker-compose up -d
if ($LASTEXITCODE -ne 0) {
    Write-Host "  [X] Falha ao subir containers" -ForegroundColor Red
    exit 1
}

Write-Host "  Aguardando PostgreSQL ficar pronto..." -ForegroundColor Yellow
$maxAttempts = 20
$attempt = 0
$ready = $false

while ($attempt -lt $maxAttempts -and -not $ready) {
    Start-Sleep -Seconds 2
    $attempt++
    $result = docker exec taskflow-postgres pg_isready -U taskflow 2>$null
    if ($LASTEXITCODE -eq 0) {
        $ready = $true
    }
}

if (-not $ready) {
    Write-Host "  [X] PostgreSQL nao ficou pronto no tempo esperado" -ForegroundColor Red
    exit 1
}
Write-Host "  [OK] Containers rodando e PostgreSQL pronto" -ForegroundColor Green

# 5. Rodar migracoes do Prisma
Write-Host ""
Write-Host "[5/5] Aplicando migracoes do Prisma..." -ForegroundColor Yellow
npx prisma migrate deploy
if ($LASTEXITCODE -ne 0) {
    Write-Host "  [!] migrate deploy falhou. Tentando migrate dev..." -ForegroundColor Yellow
    npx prisma migrate dev --name init
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  [X] Falha nas migracoes" -ForegroundColor Red
        exit 1
    }
}
Write-Host "  [OK] Migracoes aplicadas" -ForegroundColor Green

# Finalizado
Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  [OK] Setup completo!" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Para iniciar o desenvolvimento:" -ForegroundColor Cyan
Write-Host "  .\dev.ps1" -ForegroundColor White
Write-Host ""
Write-Host "Servicos disponiveis:" -ForegroundColor Cyan
Write-Host "  App:        http://localhost:3000" -ForegroundColor White
Write-Host "  Jaeger:     http://localhost:16686" -ForegroundColor White
Write-Host "  Prometheus: http://localhost:9090" -ForegroundColor White
Write-Host "  Grafana:    http://localhost:3001" -ForegroundColor White
Write-Host ""