const express = require('express');
const { exec } = require('child_process');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json({ limit: '50mb' }));

// Health check para Railway
app.get('/', (req, res) => {
  res.json({ 
    status: 'Railway Claude Code Webhook ativo!',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    timestamp: new Date().toISOString()
  });
});

// Função para clonar repositório se necessário
async function ensureRepository(repoUrl, projectPath) {
  try {
    await fs.access(projectPath);
    console.log(`Repository exists at ${projectPath}`);
  } catch {
    console.log(`Cloning repository to ${projectPath}`);
    return new Promise((resolve, reject) => {
      exec(`git clone ${repoUrl} ${projectPath}`, (error, stdout, stderr) => {
        if (error) {
          reject(error);
        } else {
          resolve(stdout);
        }
      });
    });
  }
}

// Função principal para executar Claude Code
async function executeClaudeCode(instruction, projectPath, options = {}) {
  return new Promise((resolve, reject) => {
    const {
      branch = 'feat/generate-automatic',
      createBranch = true,
      createPR = false
    } = options;

    // Verificar se Claude Code está disponível
    try {
      await new Promise((resolve, reject) => {
        exec('which claude-code', (error, stdout, stderr) => {
          if (error) {
            reject(new Error('Claude Code não encontrado. Instalação pode ter falhado.'));
          } else {
            console.log('Claude Code encontrado em:', stdout.trim());
            resolve(stdout);
          }
        });
      });
    } catch (error) {
      reject({
        success: false,
        error: 'Claude Code não está disponível no container: ' + error.message,
        suggestion: 'Verifique a instalação no Dockerfile'
      });
      return;
    }

    // Comando otimizado para Railway
    let command = `cd ${projectPath} && `;
    
    // Configurar git se necessário
    command += `git config --global user.email "emingues@gmail.com" && `;
    command += `git config --global user.name "Bot" && `;
    
    // Fetch latest changes
    command += `git fetch origin && `;
    
    // Criar/trocar para branch
    if (createBranch) {
      command += `(git checkout -b ${branch} origin/main 2>/dev/null || git checkout ${branch}) && `;
    }
    
    // Executar Claude Code
    command += `claude-code "${instruction}"`;
    
    console.log('Executando comando:', command.replace(process.env.ANTHROPIC_API_KEY || '', '***'));
    
    exec(command, { 
      maxBuffer: 10 * 1024 * 1024,
      timeout: 300000,
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY
      }
    }, (error, stdout, stderr) => {
      if (error) {
        console.error('Erro na execução:', error);
        reject({
          success: false,
          error: error.message,
          stderr: stderr
        });
        return;
      }
      
      resolve({
        success: true,
        stdout: stdout,
        stderr: stderr,
        branch: branch,
        projectPath: projectPath
      });
    });
  });
}

// Função para criar PR via GitHub CLI
async function createPullRequest(projectPath, branch, title, description) {
  return new Promise((resolve, reject) => {
    const command = `cd ${projectPath} && gh pr create --title "${title}" --body "${description}" --head ${branch} --base main`;
    
    exec(command, {
      env: {
        ...process.env,
        GH_TOKEN: process.env.GITHUB_TOKEN
      }
    }, (error, stdout, stderr) => {
      if (error) {
        console.warn('Erro ao criar PR (pode ser normal se PR já existe):', error.message);
        resolve({ success: false, error: error.message, stderr });
        return;
      }
      resolve({ 
        success: true, 
        prUrl: stdout.trim(),
        message: 'PR criado com sucesso'
      });
    });
  });
}

// Endpoint principal
app.post('/execute-claude', async (req, res) => {
  try {
    const {
      instruction,
      repoUrl,
      projectName,
      branch = 'feat/generate-automatic',
      createBranch = true,
      createPR = false,
      prTitle,
      prDescription,
      webhook_secret
    } = req.body;

    // Validação de segurança
    if (process.env.WEBHOOK_SECRET && webhook_secret !== process.env.WEBHOOK_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Validar parâmetros obrigatórios
    if (!instruction) {
      return res.status(400).json({ 
        error: 'Parâmetro obrigatório: instruction' 
      });
    }

    // Determinar caminho do projeto
    const projectPath = projectName 
      ? `/tmp/projects/${projectName}`
      : `/tmp/projects/default-project`;

    console.log(`Iniciando execução Claude Code para: ${instruction}`);
    console.log(`Projeto: ${projectPath}`);

    // Clonar repositório se fornecido
    if (repoUrl) {
      try {
        await ensureRepository(repoUrl, projectPath);
      } catch (cloneError) {
        console.warn('Erro ao clonar repositório:', cloneError.message);
        // Continua mesmo se falhar o clone
      }
    }

    // Executar Claude Code
    const result = await executeClaudeCode(instruction, projectPath, {
      branch,
      createBranch,
      createPR
    });

    let prResult = null;

    // Criar PR se solicitado e executou com sucesso
    if (createPR && result.success && process.env.GITHUB_TOKEN) {
      try {
        prResult = await createPullRequest(
          projectPath, 
          branch, 
          prTitle || `feat: ${instruction}`,
          prDescription || `Implementação automática via Railway Claude Webhook:\n\n${instruction}`
        );
      } catch (prError) {
        console.warn('Erro ao criar PR:', prError);
        prResult = { success: false, error: prError.message };
      }
    }

    // Resposta de sucesso
    res.json({
      success: true,
      message: 'Claude Code executado com sucesso via Railway!',
      result: {
        claudeCode: result,
        pullRequest: prResult,
        branch: branch,
        projectPath: projectPath,
        railway: {
          service: process.env.RAILWAY_SERVICE_NAME || 'claude-webhook',
          environment: process.env.RAILWAY_ENVIRONMENT || 'production'
        }
      }
    });

  } catch (error) {
    console.error('Erro no webhook:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Erro interno do servidor',
      railway: {
        service: process.env.RAILWAY_SERVICE_NAME,
        timestamp: new Date().toISOString()
      }
    });
  }
});

// Endpoint para listar projetos ativos
app.get('/projects', async (req, res) => {
  try {
    const projectsDir = '/tmp/projects';
    const projects = await fs.readdir(projectsDir).catch(() => []);
    
    const projectInfo = await Promise.all(projects.map(async (project) => {
      const projectPath = path.join(projectsDir, project);
      try {
        const stats = await fs.stat(projectPath);
        return {
          name: project,
          path: projectPath,
          lastModified: stats.mtime,
          isDirectory: stats.isDirectory()
        };
      } catch {
        return null;
      }
    }));

    res.json({
      projects: projectInfo.filter(Boolean),
      total: projectInfo.filter(Boolean).length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Middleware de erro global
app.use((error, req, res, next) => {
  console.error('Erro não tratado:', error);
  res.status(500).json({
    success: false,
    error: 'Erro interno do servidor',
    railway: process.env.RAILWAY_SERVICE_NAME
  });
});

// Iniciar servidor
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Railway Claude Code Webhook rodando na porta ${PORT}`);
  console.log(`📍 Environment: ${process.env.RAILWAY_ENVIRONMENT || 'development'}`);
  console.log(`🔧 Service: ${process.env.RAILWAY_SERVICE_NAME || 'local'}`);
  
  // Verificar se Claude Code está disponível
  exec('claude-code --version', (error, stdout) => {
    if (error) {
      console.warn('⚠️  Claude Code não encontrado. Será instalado no primeiro uso.');
    } else {
      console.log(`✅ Claude Code disponível: ${stdout.trim()}`);
    }
  });

  // Verificar GitHub CLI
  exec('gh --version', (error, stdout) => {
    if (error) {
      console.warn('⚠️  GitHub CLI não encontrado. PRs automáticos não funcionarão.');
    } else {
      console.log(`✅ GitHub CLI disponível`);
    }
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 Recebido SIGTERM, fazendo shutdown graceful...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('🛑 Recebido SIGINT, fazendo shutdown graceful...');
  process.exit(0);
});
