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

// Endpoint para verificar instalações e diagnóstico completo
app.get('/debug', async (req, res) => {
  const diagnostics = {
    timestamp: new Date().toISOString(),
    service: {
      name: process.env.RAILWAY_SERVICE_NAME || 'local',
      environment: process.env.RAILWAY_ENVIRONMENT || 'development',
      uptime: process.uptime()
    },
    environment: {
      node_version: process.version,
      platform: process.platform,
      arch: process.arch,
      cwd: process.cwd(),
      memory: process.memoryUsage(),
      env_vars: {
        has_anthropic_key: !!process.env.ANTHROPIC_API_KEY,
        anthropic_key_length: process.env.ANTHROPIC_API_KEY ? process.env.ANTHROPIC_API_KEY.length : 0,
        has_github_token: !!process.env.GITHUB_TOKEN,
        github_token_length: process.env.GITHUB_TOKEN ? process.env.GITHUB_TOKEN.length : 0,
        has_webhook_secret: !!process.env.WEBHOOK_SECRET,
        path: process.env.PATH,
        home: process.env.HOME
      }
    },
    installations: {},
    file_system: {
      tmp_projects_exists: false,
      app_logs_exists: false,
      permissions: {}
    }
  };

  // Verificar Claude Code
  try {
    const claudeCodePath = await new Promise((resolve, reject) => {
      exec('which claude-code', (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout.trim());
      });
    });
    
    const claudeCodeVersion = await new Promise((resolve, reject) => {
      exec('claude-code --version', { timeout: 10000 }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout.trim());
      });
    });
    
    diagnostics.installations.claude_code = {
      status: 'installed',
      path: claudeCodePath,
      version: claudeCodeVersion
    };
  } catch (error) {
    diagnostics.installations.claude_code = {
      status: 'not_found',
      error: error.message
    };
    
    // Tentar encontrar em outros locais
    const possiblePaths = [
      '/usr/local/bin/claude-code',
      '/usr/bin/claude-code',
      '/app/node_modules/.bin/claude-code',
      '/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude-code'
    ];
    
    for (const path of possiblePaths) {
      try {
        require('fs').accessSync(path);
        diagnostics.installations.claude_code.alternative_path = path;
        break;
      } catch (e) {
        // Continue procurando
      }
    }
  }

  // Verificar Git
  try {
    const gitVersion = await new Promise((resolve, reject) => {
      exec('git --version', (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout.trim());
      });
    });
    
    const gitConfig = await new Promise((resolve, reject) => {
      exec('git config --global --list', (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout.trim());
      });
    });
    
    diagnostics.installations.git = {
      status: 'installed',
      version: gitVersion,
      global_config: gitConfig.split('\n').filter(line => 
        line.includes('user.name') || line.includes('user.email')
      )
    };
  } catch (error) {
    diagnostics.installations.git = {
      status: 'not_found',
      error: error.message
    };
  }

  // Verificar GitHub CLI
  try {
    const ghVersion = await new Promise((resolve, reject) => {
      exec('gh --version', (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout.trim());
      });
    });
    
    // Verificar autenticação do GitHub
    const ghAuth = await new Promise((resolve, reject) => {
      exec('gh auth status', (error, stdout, stderr) => {
        // gh auth status retorna info no stderr mesmo quando ok
        resolve(stderr || stdout || 'No auth info');
      });
    });
    
    diagnostics.installations.github_cli = {
      status: 'installed',
      version: ghVersion,
      auth_status: ghAuth
    };
  } catch (error) {
    diagnostics.installations.github_cli = {
      status: 'not_found',
      error: error.message
    };
  }

  // Verificar NPM global packages
  try {
    const npmList = await new Promise((resolve, reject) => {
      exec('npm list -g --depth=0', (error, stdout) => {
        if (error && !stdout) reject(error);
        else resolve(stdout || '');
      });
    });
    
    diagnostics.installations.npm_global = {
      status: 'checked',
      packages: npmList.split('\n').filter(line => 
        line.includes('@anthropic-ai/claude-code') || line.includes('claude-code')
      )
    };
  } catch (error) {
    diagnostics.installations.npm_global = {
      status: 'error',
      error: error.message
    };
  }

  // Verificar sistema de arquivos
  try {
    const fs = require('fs');
    
    // Verificar diretórios importantes
    diagnostics.file_system.tmp_projects_exists = fs.existsSync('/tmp/projects');
    diagnostics.file_system.app_logs_exists = fs.existsSync('/app/logs');
    
    // Verificar permissões
    try {
      fs.accessSync('/tmp/projects', fs.constants.W_OK);
      diagnostics.file_system.permissions.tmp_projects = 'writable';
    } catch {
      diagnostics.file_system.permissions.tmp_projects = 'not_writable';
    }
    
    try {
      fs.accessSync('/app', fs.constants.W_OK);
      diagnostics.file_system.permissions.app_dir = 'writable';
    } catch {
      diagnostics.file_system.permissions.app_dir = 'not_writable';
    }
    
    // Listar conteúdo de /usr/local/bin
    try {
      const binContents = fs.readdirSync('/usr/local/bin');
      diagnostics.file_system.usr_local_bin = binContents.filter(file => 
        file.includes('claude') || file.includes('node') || file.includes('npm')
      );
    } catch (e) {
      diagnostics.file_system.usr_local_bin_error = e.message;
    }
    
  } catch (error) {
    diagnostics.file_system.error = error.message;
  }

  // Adicionar recomendações baseadas nos resultados
  diagnostics.recommendations = [];
  
  if (diagnostics.installations.claude_code.status !== 'installed') {
    diagnostics.recommendations.push({
      type: 'warning',
      message: 'Claude Code não está instalado ou não está no PATH',
      action: 'Verificar instalação no Dockerfile ou tentar instalação dinâmica'
    });
  }
  
  if (!diagnostics.environment.env_vars.has_anthropic_key) {
    diagnostics.recommendations.push({
      type: 'error',
      message: 'ANTHROPIC_API_KEY não configurada',
      action: 'Configurar a variável de ambiente ANTHROPIC_API_KEY no Railway'
    });
  }
  
  if (!diagnostics.environment.env_vars.has_webhook_secret) {
    diagnostics.recommendations.push({
      type: 'warning',
      message: 'WEBHOOK_SECRET não configurado',
      action: 'Configurar WEBHOOK_SECRET para segurança'
    });
  }
  
  if (diagnostics.installations.github_cli.status !== 'installed') {
    diagnostics.recommendations.push({
      type: 'info',
      message: 'GitHub CLI não disponível',
      action: 'PRs automáticos não funcionarão sem GitHub CLI'
    });
  }

  res.json(diagnostics);
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
