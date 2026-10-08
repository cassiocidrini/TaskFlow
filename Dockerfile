# ============================================================
# Stage 1: Build
# ============================================================
FROM node:20-alpine AS builder

WORKDIR /app

# Copia apenas os arquivos de dependências primeiro (cache de layers)
COPY package*.json ./
COPY prisma ./prisma/
COPY prisma.config.ts ./

# Instala TODAS as dependências (incluindo dev, para o build)
RUN npm ci

# Copia o resto do código
COPY . .

# Gera o Prisma Client
RUN npx prisma generate

# Compila TypeScript → JavaScript
RUN npm run build

# ============================================================
# Stage 2: Runtime (imagem final, menor)
# ============================================================
FROM node:20-alpine

WORKDIR /app

# Copia apenas o necessário do estágio anterior
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./

EXPOSE 3000

CMD ["node", "dist/main"]