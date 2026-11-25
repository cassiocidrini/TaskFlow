# syntax=docker/dockerfile:1
#
# Imagem de produção do TaskFlow (Etapa E.1, Módulo 03). Uma imagem para todos os processos: a API é o padrão, e o
# mesmo artefato roda o relay, os consumers e os CLIs trocando só o comando (`node dist/relay`, ...).
#
#   deps       npm ci completo (cache: só refaz se o package-lock mudar)
#   build      prisma generate + nest build (o plugin do Swagger só roda no nest build)
#   prod-deps  só as dependências de produção + o client gerado do Prisma
#   migrate    `docker build --target migrate`: prisma migrate deploy, uma vez antes do deploy
#   runtime    a imagem final (último estágio = o build padrão)
#
# Tag exata E digest: a mesma imagem base em todo build. Tag móvel (`node:24-alpine`) muda por baixo sem nenhum
# commit, e o build de amanhã deixa de ser o que foi testado hoje.
# Escrita UMA vez, num estágio `base` (e não num ARG: o hadolint e o Dependabot não leem a tag dentro de `${...}`).
FROM node:24.22.3-alpine3.24@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS base
WORKDIR /app

# ============================================================
FROM base AS deps
COPY package.json package-lock.json ./
# Cache do npm montado no build (BuildKit): acelera reinstalações sem deixar o cache em nenhuma camada
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

# ============================================================
FROM deps AS build
COPY nest-cli.json tsconfig.json tsconfig.build.json prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src
RUN npx prisma generate && npm run build

# ============================================================
FROM base AS prod-deps
COPY package.json package-lock.json ./
# --omit=optional também: o @prisma/client declara `prisma` e `typescript` como peers OPCIONAIS, e, por serem
# devDependencies da raiz, o lockfile os marca `devOptional` ("dev numa árvore, opcional na outra"). Só com
# --omit=dev, a CLI do Prisma, o Studio e o TypeScript (102 pacotes) iam para produção. Os únicos opcionais de
# produção de verdade são pg-cloudflare (Workers) e @pkgjs/parseargs (polyfill de Node antigo). Uma dependência
# opcional nova que a API precise quebra o boot, e o job da imagem no CI pega.
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --omit=optional --no-audit --no-fund
# O client gerado mora em node_modules/.prisma, fora de qualquer pacote: o `npm ci --omit=dev` não o recria
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma

# ============================================================
# Migração como passo separado, e não no boot da API: com várias réplicas, cada uma tentaria migrar ao subir
# (corrida), e a API precisaria de permissão de DDL no banco. No Kubernetes, vira um Job antes do rollout (Módulo 02).
FROM deps AS migrate
COPY prisma.config.ts ./
COPY prisma ./prisma
USER 1000:1000
CMD ["./node_modules/.bin/prisma", "migrate", "deploy"]

# ============================================================
FROM base AS runtime
ENV NODE_ENV=production

# O runtime não usa gerenciador de pacotes (o CMD é `node`): sem o npm, saem 6 das 11 CVEs HIGH que sobravam
# (undici e brace-expansion empacotados nele), e quem invadir o container não tem um instalador à mão. A imagem
# oficial traz também o corepack e o yarn 1 (em /opt). Os estágios de build continuam com npm.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-v* \
  /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg

# Arquivos do root (o COPY sem --chown) e processo do usuário `node` (uid 1000, já existe na imagem oficial): o
# processo LÊ o próprio código, mas não o altera. Uma invasão da API não ganha root no container nem consegue
# persistir nada em dist/ ou node_modules/.
# Numérico (1000:1000 = node:node), e não `USER node`: com `runAsNonRoot: true`, o Kubernetes só consegue CONFERIR
# que o usuário não é root se o uid for um número (pelo nome, recusa o pod). Regra DL3066 do hadolint.
COPY package.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER 1000:1000

EXPOSE 3000

# Liveness, não readiness: o /health/ready depende do banco, e com o banco fora todas as réplicas ficariam
# "unhealthy" ao mesmo tempo (um orquestrador que reinicia unhealthy derrubaria todas por um problema que não é
# delas). `fetch` do próprio Node: sem curl/wget, menos um pacote na imagem.
# Vale para a API: um worker (relay, consumers) não escuta a porta 3000 e roda com o healthcheck desligado ou
# sobrescrito. O Kubernetes ignora o HEALTHCHECK: lá as probes ficam no manifesto (Módulo 02).
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

# Forma exec e `node` direto: o node é o PID 1 e recebe o SIGTERM do `docker stop`, que dispara o graceful shutdown
# (Módulo 01). Medido (Módulo 03, Etapa E.1):
#   - um shell que continua vivo como PID 1 (`CMD node dist/main; echo saiu`) NÃO repassa o sinal: SIGKILL depois de
#     10 s, exit 137, sem drenagem;
#   - `npm run start:prod` (npm 11) repassa, mas sai com 1 em vez de 0 e deixa um processo a mais no container.
CMD ["node", "dist/main"]
