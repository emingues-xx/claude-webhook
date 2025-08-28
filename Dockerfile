# Dockerfile para Claude Code Webhook - Railway (Versão Corrigida)
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
    python3 \
    make \
    g++ \
    && rm -rf /var/cache/apk/*

# Criar usuário não-root para segurança
RUN addgroup -g 1001 -S nodejs && \
    adduser -S claude -u 1001

# Definir diretório de trabalho
WORKDIR /app

# Copiar package.json primeiro
COPY package.json ./

# Instalar dependências Node.js (sem package-lock.json)
RUN npm install --production --no-audit --no-fund && \
    npm cache clean --force

# Instalar Claude Code globalmente
RUN npm install -g @anthropic-ai/claude-code@latest --unsafe-perm

# Instalar GitHub CLI para Alpine
RUN curl -fsSL https://github.com/cli/cli/releases/latest/download/gh_$(cat /etc/alpine-release | cut -d'.' -f1-2)_linux_amd64.tar.gz -o gh.tar.gz 2>/dev/null || \
    curl -fsSL https://github.com/cli/cli/releases/download/v2.40.1/gh_2.40.1_linux_amd64.tar.gz -o gh.tar.gz && \
    tar -xzf gh.tar.gz --strip-components=1 --wildcards '*/bin/gh' && \
    mv bin/gh /usr/local/bin/ && \
    rm -rf gh.tar.gz bin/ && \
    chmod +x /usr/local/bin/gh || echo "GitHub CLI installation failed, continuing without it"

# Criar diretórios necessários com permissões corretas
RUN mkdir -p /tmp/projects && \
    mkdir -p /app/logs && \
    chmod 755 /tmp/projects && \
    chmod 755 /app/logs

# Configurar Git globalmente para o container
RUN git config --global user.name "Claude Railway Bot" && \
    git config --global user.email "railway@claude-webhook.com" && \
    git config --global init.defaultBranch main && \
    git config --global pull.rebase false && \
    git config --global safe.directory '*'

# Copiar código da aplicação
COPY --chown=claude:nodejs server.js ./
COPY --chown=claude:nodejs README.md ./ 2>/dev/null || echo "README.md not found, skipping"

# Ajustar permissões
RUN chown -R claude:nodejs /app && \
    chown -R claude:nodejs /tmp/projects

# Mudar para usuário não-root
USER claude

# Definir variáveis de ambiente
ENV NODE_ENV=production
ENV PORT=3000
ENV PATH="/usr/local/bin:$PATH"
ENV HOME=/app

# Criar diretório home do usuário claude
RUN mkdir -p /app/.npm && \
    mkdir -p /app/.config

# Expor porta
EXPOSE 3000

# Health check mais robusto
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# Script de entrada para verificar dependências
RUN echo '#!/bin/sh\n\
echo "🚀 Iniciando Claude Code Webhook Server..."\n\
echo "📍 Node.js version: $(node --version)"\n\
echo "📦 NPM version: $(npm --version)"\n\
echo "🔧 Verificando Claude Code..."\n\
claude-code --version 2>/dev/null && echo "✅ Claude Code OK" || echo "⚠️ Claude Code não encontrado"\n\
echo "🔧 Verificando GitHub CLI..."\n\
gh --version 2>/dev/null && echo "✅ GitHub CLI OK" || echo "⚠️ GitHub CLI não encontrado"\n\
echo "🌟 Iniciando servidor na porta $PORT"\n\
exec node server.js\n\
' > /app/start.sh && chmod +x /app/start.sh

# Comando para iniciar a aplicação
CMD ["/app/start.sh"]
