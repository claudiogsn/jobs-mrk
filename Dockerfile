# Dockerfile do jobs-mrk (Node). Copie para a raiz do repositório como Dockerfile, junto com o
# .dockerignore.jobs (como .dockerignore).
#
# Uma imagem para os três processos; o comando de cada um fica no docker-stack.yml
# (processes/api.js, processes/scheduler.js e processes/consumer.js). Substitui o PM2: o Swarm
# reinicia o container que cair.
#
# As dependências do jobs-mrk são JavaScript puro, então o npm ci roda na arquitetura do runner
# (BUILDPLATFORM) e só a imagem final é arm64 (Graviton).
FROM --platform=$BUILDPLATFORM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
RUN npm ci --omit=dev --workspaces --include-workspace-root

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production TZ=America/Fortaleza
RUN apk add --no-cache tzdata && addgroup -S app && adduser -S app -G app \
    && mkdir -p /app/reports /app/workers/reports /app/logs /data/uploads/3lm \
    && chown -R app:app /app /data
COPY --from=deps --chown=app:app /app/node_modules ./node_modules
COPY --chown=app:app . .
USER app
EXPOSE 3005
CMD ["node", "-r", "@mrksolucoes/observability/register", "processes/api.js"]
