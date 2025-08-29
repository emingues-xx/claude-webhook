# Dockerfile para Claude Code Webhook - Railway (Versão Simples)
FROM node:18-alpine

# Instalar dependências do sistema
RUN apk add --no-cache git curl bash

# Criar diretório da aplicação
WORKDIR /app

# Copiar package.json e instalar dependências
COPY package.json ./
RUN npm install --production

# Instalar Claude Code globalmente
RUN npm install -g @anthropic-ai/claude-code

# Tentar instalar GitHub CLI (opcional)
RUN curl -fsSL https://github.com/cli/cli/releases/download/v2.40.1/gh_2.40.1_linux_amd64.tar.gz -o gh.tar.gz && \
    tar -xzf gh.tar.gz && \
    mv gh_*/bin/gh /usr/local/bin/ && \
    rm -rf gh* || echo "GitHub CLI não instalado"

# Copiar código da aplicação
COPY . .

# Configurar Git
RUN git config --global user.name "Bot Railway" && \
    git config --global user.email "emingues@gmail.com"

# Criar diretórios necessários
RUN mkdir -p /tmp/projects /app/logs

# Expor porta
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# Iniciar aplicação
CMD ["node", "server.js"]
