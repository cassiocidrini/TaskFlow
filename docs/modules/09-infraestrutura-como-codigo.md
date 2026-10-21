# Módulo 09 — Infraestrutura como Código (Terraform)

> **Projeto:** TaskFlow · **Trilha:** Do Pleno ao Excelente · **Última revisão:** 21/10/2026
>
> **Onde vive no código:** [`terraform/`](../../terraform/) (`main.tf`, `sns.tf`, `backend.tf`) ·
> script [`scripts/dev/localstack.mjs`](../../scripts/dev/localstack.mjs) (`npm run aws:*`) ·
> LocalStack no [`docker-compose.yml`](../../docker-compose.yml)

---

## 🎯 Objetivo

Provisionar os serviços AWS do TaskFlow (S3, SQS, SNS e IAM) com **Terraform**, de forma **declarativa, versionada
e reproduzível**, usando o **LocalStack** para emular a AWS localmente, sem custo.

**Por que importa:** infraestrutura criada clicando no console não tem histórico, revisão nem reprodutibilidade. Com
IaC, a infraestrutura passa pelo mesmo ciclo do código: PR, revisão, `plan`, `apply`.

---

## 🧠 Conceitos

### IaC: manual × declarativo

| Sem IaC (console) | Com IaC (Terraform) |
|---|---|
| Cliques que ninguém registra | Arquivos `.tf` versionados no Git |
| Documentação que envelhece | O código **é** a documentação |
| Difícil recriar em outra conta | `terraform apply` recria tudo |
| Mudança sem revisão | `plan` revisado num PR antes do `apply` |
| Desfazer na memória | `git revert` + `apply` |

### Por que Terraform

| Ferramenta | Prós | Contras |
|---|---|---|
| **Terraform** | Multi-cloud, HCL simples, maior ecossistema | Licença BSL 1.1 desde 2023 |
| **OpenTofu** | Fork aberto (MPL 2.0) do Terraform, mantido pela Linux Foundation | Ecossistema menor |
| **CloudFormation** | Nativo da AWS | Só AWS, YAML verboso |
| **AWS CDK** | TypeScript/Python, gera CloudFormation | Só AWS |
| **Pulumi** | Linguagens de programação reais | Menor adoção |

### Blocos do HCL

| Bloco | Papel |
|---|---|
| `terraform {}` | Versão do Terraform, providers exigidos, backend |
| `provider "aws" {}` | Como falar com a API (região, credenciais, endpoints) |
| `resource "tipo" "nome" {}` | Um recurso a ser criado/gerenciado |
| `output "nome" {}` | Um valor exposto depois do `apply` (ARN, URL…) |
| `variable` · `data` · `module` | Entradas, consulta a recursos existentes, reuso |

HCL é **declarativa**: você descreve **o estado desejado**, e o Terraform calcula o que criar, alterar ou destruir.

### State e backend

O **state** (`terraform.tfstate`) mapeia cada recurso do código ao recurso real (IDs, ARNs, dependências). Sem ele,
o Terraform não sabe o que já existe. Por isso:

| Backend | Quando |
|---|---|
| `local` (padrão) | Estudo solo |
| **Remoto** (`s3`, `gcs`, `azurerm`, Terraform Cloud) | Times, CI/CD, produção |

Um backend remoto serve para três coisas: **compartilhar** o state entre pessoas, **guardar** com segurança (o state
pode conter segredos) e **travar** (*lock*) para impedir dois `apply` simultâneos. **Sem o lock, o backend remoto
resolve só metade do problema**, e o TaskFlow está exatamente nessa metade (ver Limitações).

---

## 🛠️ O que existe no TaskFlow

### Recursos

| Recurso | Arquivo | Para quê |
|---|---|---|
| S3 bucket `taskflow-storage-bucket` | `main.tf` | Armazenamento de arquivos |
| SQS `taskflow-sync-queue` (visibilidade 30 s, retenção 1 dia) | `main.tf` | Fila de sincronização |
| SNS `taskflow-events` | `sns.tf` | Publicação de eventos (pub/sub) |
| IAM role `taskflow-lambda-sync-role` | `sns.tf` | Identidade de uma futura Lambda de sincronização |
| IAM policy `taskflow-lambda-sync-policy` | `sns.tf` | Permissões dessa Lambda |

Todos com tags padronizadas (`Environment`, `Project`, `ManagedBy = Terraform`) e com `output`s dos ARNs e URLs.

> **Escopo honesto:** esses recursos são **provisionados**, mas a API ainda **não os usa**. O EventBus do TaskFlow
> roda em memória (Módulo 05). O SNS e o SQS são a infraestrutura que um EventBus distribuído usaria.

### IAM de menor privilégio

```hcl
resource "aws_iam_policy" "lambda_sync_policy" {
  policy = jsonencode({
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
        Resource = aws_sqs_queue.sync_queue.arn                 # SÓ esta fila
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject"]
        Resource = "${aws_s3_bucket.taskflow_bucket.arn}/*"    # SÓ este bucket
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "*"                                         # padrão aceito para logs
      },
    ]
  })
}
```

Ações específicas (e não `sqs:*`) sobre recursos específicos (e não `"Resource": "*"`): se a Lambda for comprometida,
o estrago fica limitado a uma fila e um bucket. É o princípio de **menor privilégio**, equivalente ao
`permissions: contents: read` do CI (Módulo 03).

### Provider e backend apontando para o LocalStack

```hcl
provider "aws" {
  region     = "us-east-1"
  access_key = "test"          # o LocalStack aceita qualquer valor
  secret_key = "test"

  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true
  s3_use_path_style           = true

  endpoints {
    s3  = "http://localhost:4566"
    sqs = "http://localhost:4566"
    sns = "http://localhost:4566"
    iam = "http://localhost:4566"
  }
}
```

O `backend "s3"` ([`backend.tf`](../../terraform/backend.tf)) guarda o state em
`s3://taskflow-terraform-state/taskflow/terraform.tfstate` e **repete** as flags `skip_*` e o endpoint: o backend
**não herda** a configuração do provider (problema nº 4).

---

## 📋 Como reproduzir

```bash
npm run aws:up          # sobe o LocalStack (--wait no healthcheck), cria o bucket do state, init + apply
npm run aws:down        # remove o container e o volume do LocalStack: recursos E state somem juntos
npm run aws:recreate    # down + up
npm run aws:resources   # lista filas SQS e buckets S3
```

Funciona igual em Linux, macOS e Windows (Node puro). Exige `LOCALSTACK_AUTH_TOKEN` no `.env` e o `terraform`
no PATH. O `aws:down` não roda `terraform destroy`: o state vive no S3 do **próprio** LocalStack, então apagar o
volume remove os recursos e o state de uma vez.

> **O LocalStack não guarda os recursos entre reinícios** (sem `PERSISTENCE=1`, o padrão): depois de reiniciar o
> Docker ou a máquina, filas, buckets e o próprio state somem. Basta rodar `npm run aws:up` de novo. Como o state
> some junto com os recursos, o Terraform recria tudo sem conflito.

Ou manualmente, dentro de `terraform/`:

```bash
terraform init -reconfigure   # baixa o provider e configura o backend
terraform plan                # o que vai mudar: SEMPRE revisar antes do apply
terraform apply
terraform output              # ARNs e URLs
terraform state list          # recursos que o Terraform gerencia
terraform destroy
```

Conferindo no LocalStack:

```bash
docker exec taskflow-localstack awslocal s3 ls
docker exec taskflow-localstack awslocal sqs list-queues
docker exec taskflow-localstack awslocal sns list-topics
docker exec taskflow-localstack awslocal iam list-roles
```

---

## ⚠️ Problemas encontrados e soluções

| # | Problema | Causa | Solução |
|---:|---|---|---|
| 1 | `terraform` não reconhecido no PowerShell | PATH não atualizado | Adicionar `C:\HashiCorp\Terraform` ao PATH do usuário |
| 2 | `Too many command line arguments` em `plan -out=plan.out` | O PowerShell interpreta o `=` de outro jeito | `-out plan.out` (com espaço) |
| 3 | Um *warning* derrubava o script de setup | Com `$ErrorActionPreference = "Stop"`, o PowerShell trata saída em stderr como erro | Salvar e restaurar a preferência em volta do comando |
| 4 | `InvalidClientTokenId` no backend S3 | O backend **não herda** as flags `skip_*` do provider | Repetir as flags dentro do bloco `backend "s3"` |
| 5 | `force_path_style` deprecated | Renomeado no Terraform 1.6+ | `use_path_style` |
| 6 | `dynamodb_table` deprecated no backend | O Terraform 1.10+ trava o state com um *lockfile* no próprio S3 | Removido, **mas o substituto (`use_lockfile`) não foi adicionado**: o backend ficou sem lock |
| 7 | `rds service is not included within your LocalStack license` | RDS não está no plano gratuito do LocalStack | Remover o `rds.tf`; o PostgreSQL continua no Docker Compose |
| 8 | Scripts `.ps1` antigos: o clean apagava o `.terraform.lock.hcl` (versionado) e um `apply` com erro imprimia `[OK]` | O `try/catch` do PowerShell não captura erro de executável externo, e a saída ia para `Out-Null`; o lock file era tratado como lixo | Migração para `scripts/dev/localstack.mjs`: exit code checado em todo comando, saída visível, só o cache `.terraform/` é apagado |

### Lições

1. **Declarativo é poder e perigo.** Remover um `resource` do `.tf` **destrói** o recurso real no próximo `apply`. Por isso o `plan` é revisado antes, sempre.
2. **Backend remoto sem lock é meio backend.** Ele compartilha o state, mas não impede que dois `apply` simultâneos o corrompam.
3. **Emuladores têm limites.** O LocalStack gratuito não tem RDS; conhecer os limites da ferramenta e ter um plano B (aqui, o Postgres em Docker) faz parte da engenharia.
4. **Documentação também precisa ser verificada.** A primeira versão deste módulo afirmava que o lock estava configurado; o arquivo nunca teve a linha.

---

## 🚧 Limitações e próximos passos

- **Sem lock do state:** adicionar `use_lockfile = true` ao `backend "s3"` e exigir `required_version = ">= 1.10.0"` (versão em que o lock nativo do S3 passou a existir).
- **Tudo num diretório só, sem variáveis:** nomes, região e endpoints estão fixos. O próximo passo é `variable`s + um `.tfvars` por ambiente (`dev`, `prod`), ou *workspaces*.
- **Sem módulos:** o padrão SQS + policy poderia virar um `module` reutilizável.
- **IaC fora do CI:** um job com `terraform fmt -check`, `validate` e `plan` em cada PR, com o plano publicado como comentário.
- **Recursos sem uso pela API:** SNS e SQS existem, mas o EventBus ainda é em memória.

---

## ✅ Checklist

- [x] 5 recursos AWS provisionados de forma declarativa (S3, SQS, SNS, IAM role e policy)
- [x] IAM de menor privilégio, restrito a ARNs específicos
- [x] State em backend remoto (S3 no LocalStack)
- [x] Scripts de setup, limpeza e recriação
- [x] Ciclo `init` → `plan` → `apply` → `destroy` dominado
- [ ] **Lock do state** (`use_lockfile`)
- [ ] Variáveis por ambiente e `terraform plan` no CI

---

**Anterior:** [Módulo 08 — IA no desenvolvimento](08-ia-no-desenvolvimento.md) ·
**Próximo:** [Módulo 10 — Performance e load testing](10-performance-load-testing.md)
