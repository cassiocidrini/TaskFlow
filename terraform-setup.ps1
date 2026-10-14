# terraform-setup.ps1
# Recria toda a infraestrutura LocalStack + Terraform do zero
# Uso: .\terraform-setup.ps1

$ErrorActionPreference = "Stop"
$terraformDir = Join-Path $PSScriptRoot "terraform"
$composeFile = Join-Path $PSScriptRoot "docker-compose.yml"

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  Terraform + LocalStack - SETUP" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

# ------------------------------------------------------------------
# 1. Verifica pre-requisitos
# ------------------------------------------------------------------
Write-Host "[1/7] Verificando pre-requisitos..." -ForegroundColor Yellow

try {
    $tfVersion = terraform --version | Select-Object -First 1
    Write-Host "      [OK] $tfVersion" -ForegroundColor Green
} catch {
    Write-Host "      [X] Terraform nao encontrado no PATH" -ForegroundColor Red
    exit 1
}

try {
    docker ps | Out-Null
    Write-Host "      [OK] Docker daemon esta rodando" -ForegroundColor Green
} catch {
    Write-Host "      [X] Docker nao esta rodando. Abra o Docker Desktop." -ForegroundColor Red
    exit 1
}

# ------------------------------------------------------------------
# 2. Verifica se o docker-compose.yml tem os servicos necessarios
# ------------------------------------------------------------------
Write-Host "[2/7] Verificando configuracao do LocalStack..." -ForegroundColor Yellow

if (-not (Test-Path $composeFile)) {
    Write-Host "      [X] docker-compose.yml nao encontrado" -ForegroundColor Red
    exit 1
}

$composeContent = Get-Content $composeFile -Raw
if ($composeContent -notmatch "SERVICES=sqs,s3,dynamodb,sns,iam") {
    Write-Host "      [!] A variavel SERVICES do LocalStack nao inclui todos os servicos" -ForegroundColor Yellow
    Write-Host "      Esperado: SERVICES=sqs,s3,dynamodb,sns,iam" -ForegroundColor Yellow
    Write-Host "      Edite o docker-compose.yml e rode de novo." -ForegroundColor Yellow
    exit 1
}
Write-Host "      [OK] docker-compose.yml esta correto" -ForegroundColor Green

# ------------------------------------------------------------------
# 3. Sobe o LocalStack
# ------------------------------------------------------------------
Write-Host "[3/7] Subindo LocalStack..." -ForegroundColor Yellow

# Salva a preferência atual e desabilita temporariamente o "Stop"
$oldPref = $ErrorActionPreference
$ErrorActionPreference = "Continue"

Push-Location $PSScriptRoot
docker-compose up -d localstack 2>&1 | Out-Null
$composeExitCode = $LASTEXITCODE
Pop-Location

# Restaura a preferência original
$ErrorActionPreference = $oldPref

if ($composeExitCode -ne 0) {
    Write-Host "      [X] Falha ao subir o LocalStack (exit code: $composeExitCode)" -ForegroundColor Red
    exit 1
}

Write-Host "      [OK] Container iniciado" -ForegroundColor Green

# ------------------------------------------------------------------
# 4. Aguarda o LocalStack ficar healthy
# ------------------------------------------------------------------
Write-Host "[4/7] Aguardando LocalStack ficar healthy (max 90s)..." -ForegroundColor Yellow

$maxAttempts = 30
$attempt = 0
$healthy = $false

while ($attempt -lt $maxAttempts -and -not $healthy) {
    Start-Sleep -Seconds 3
    $attempt++
    $status = docker inspect --format='{{.State.Health.Status}}' taskflow-localstack 2>$null
    if ($status -eq "healthy") {
        $healthy = $true
    } else {
        Write-Host "      Tentativa $attempt/$maxAttempts - status: $status" -ForegroundColor DarkGray
    }
}

if (-not $healthy) {
    Write-Host "      [X] LocalStack nao ficou healthy no tempo esperado" -ForegroundColor Red
    Write-Host "      Veja os logs: docker logs taskflow-localstack" -ForegroundColor Yellow
    exit 1
}
Write-Host "      [OK] LocalStack esta healthy" -ForegroundColor Green

# ------------------------------------------------------------------
# 5. Confirma que todos os servicos estao disponiveis
# ------------------------------------------------------------------
Write-Host "[5/7] Confirmando servicos do LocalStack..." -ForegroundColor Yellow

$services = (Invoke-RestMethod http://localhost:4566/_localstack/health).services
$required = @("sqs", "s3", "dynamodb", "sns", "iam")
$allOk = $true

foreach ($svc in $required) {
    $status = $services.$svc
    if ($status -in @("available", "running")) {
        Write-Host "      [OK] $svc : $status" -ForegroundColor Green
    } else {
        Write-Host "      [X] $svc : $status" -ForegroundColor Red
        $allOk = $false
    }
}

if (-not $allOk) {
    Write-Host "      [X] Alguns servicos nao estao disponiveis" -ForegroundColor Red
    exit 1
}

# ------------------------------------------------------------------
# 6. Cria o bucket S3 do backend do Terraform
# ------------------------------------------------------------------
Write-Host "[6/7] Criando bucket S3 do backend Terraform..." -ForegroundColor Yellow

docker exec taskflow-localstack awslocal s3 mb s3://taskflow-terraform-state 2>&1 | Out-Null
Write-Host "      [OK] Bucket taskflow-terraform-state pronto" -ForegroundColor Green

# ------------------------------------------------------------------
# 7. Inicializa e aplica o Terraform
# ------------------------------------------------------------------
Write-Host "[7/7] Rodando Terraform..." -ForegroundColor Yellow

Push-Location $terraformDir

try {
    terraform init -reconfigure 2>&1 | Out-Null
    Write-Host "      [OK] Terraform inicializado" -ForegroundColor Green

    terraform apply -auto-approve 2>&1 | Out-Null
    Write-Host "      [OK] Recursos aplicados" -ForegroundColor Green
} catch {
    Write-Host "      [X] Falha no Terraform. Veja os logs acima." -ForegroundColor Red
    Pop-Location
    exit 1
}

# Mostra os outputs
Write-Host ""
Write-Host "      Outputs do Terraform:" -ForegroundColor Cyan
terraform output
Pop-Location

Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  [OK] Setup completo!" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Servicos disponiveis no LocalStack:" -ForegroundColor Cyan
Write-Host "   - S3: taskflow-storage-bucket, taskflow-terraform-state" -ForegroundColor White
Write-Host "   - SQS: taskflow-sync-queue" -ForegroundColor White
Write-Host "   - SNS: taskflow-events" -ForegroundColor White
Write-Host "   - IAM: taskflow-lambda-sync-role, taskflow-lambda-sync-policy" -ForegroundColor White
Write-Host ""