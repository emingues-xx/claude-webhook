# Dockerfile para Claude Code Webhook - Railway
FROM node:18-alpine

# Metadata do container
LABEL maintainer="seu-email@exemplo.com"
LABEL description="Claude Code Webhook Server for Railway"
LABEL version="1.0.0"

# Instalar dependências do sistema necessárias
RUN apk update && apk add --no-cache \
    git \
    curl \
    bash \
    openssh-client \
    ca-certificates \
    && rm -rf /var/cache/apk/*

# Criar usuário não-root para segurança
RUN addgroup -g 1001 -S nodejs && \
    adduser -S claude -u 1001

# Definir diretório de trabalho
WORKDIR /app

# Copiar arquivos de dependências primeiro (para cache do Docker)
COPY package*.json ./

# Instalar dependências Node.js
RUN npm ci --only=production && \
    npm cache clean --force

# Instalar Claude Code globalmente
RUN npm install -g @anthropic-ai/claude-code@latest

# Instalar GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | \
    tee /usr/share/keyrings/githubcli-archive-keyring.gpg > /dev/null && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | \
    tee /etc/apt/sources.list.d/github-cli.list > /dev/null || true

# Como estamos no Alpine, instalar gh via download direto
RUN wget https://github.com/cli/cli/releases/latest/download/gh_*_linux_amd64.tar.gz -O gh.tar.gz && \
    tar -xzf gh.tar.gz && \
    mv gh_*/bin/gh /usr/local/bin/ && \
    rm -rf gh* || echo "GitHub CLI installation failed, continuing..."

# Criar diretórios necessários
RUN mkdir -p /tmp/projects && \
    mkdir -p /app/logs && \
    chown -R claude:nodejs /tmp/projects && \
    chown -R claude:nodejs /app

# Copiar código da aplicação
COPY --chown=claude:nodejs . .

# Configurar Git globalmente para o container
RUN git config --global user.name "Claude Railway Bot" && \
    git config --global user.email "railway@claude-webhook.com" && \
    git config --global init.defaultBranch main && \
    git config --global pull.rebase false

# Mudar para usuário não-root
USER claude

# Definir variáveis de ambiente
ENV NODE_ENV=production
ENV PORT=3000
ENV PATH="/usr/local/bin:$PATH"

# Expor porta
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# Comando para iniciar a aplicação
CMD ["node", "server.js"]
