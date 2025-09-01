require('dotenv').config();
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

async function ensureRepository(repoUrl, projectPath) {
  try {
    await fs.access(projectPath);
   
    // Atualizar repositório existente
    await new Promise((resolve, reject) => {
      exec(`cd "${projectPath}" && git fetch origin && git pull origin main`, {
        timeout: 30000
      }, (error, stdout, stderr) => {
        if (error) {
          console.warn('⚠️ Falha ao atualizar repositório:', error.message);
        }
        resolve(); // Continua mesmo se falhar
      });
    });
    
  } catch {
    console.log(`📦 Clonando repositório: ${repoUrl}`);
    
    await new Promise((resolve, reject) => {
      exec(`git clone ${repoUrl} ${projectPath}`, {
        timeout: 60000
      }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`Falha ao clonar repositório: ${error.message}`));
        } else {
          resolve();
        }
      });
    });
  }
}

async function executeClaudeCode(instruction, projectPath) {
  return new Promise(async (resolve, reject) => {
    try { 
      instruction = instruction.replace(/"/g, '\\"');    
      let claudeCommand = 'claude';

      // Criar diretório se não existir
      await fs.mkdir(projectPath, { recursive: true });
                 
      const command = `cd "${projectPath}" && echo "2" | ${claudeCommand} --dangerously-skip-permissions "${instruction}"`;
      
      const startTime = Date.now();
      
      // Executar comando diretamente
      const result = await new Promise((resolve, reject) => {
        const { spawn } = require('child_process');
        
        // Usar shell para executar o comando com pipe
        const child = spawn('bash', ['-c', command], {
          stdio: ['pipe', 'pipe', 'pipe'],
          cwd: projectPath,
          env: {
            ...process.env,
            // Variáveis essenciais do claude-wrapper.sh
            PATH: '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:' + (process.env.PATH || ''),
            CLAUDE_SKIP_CONFIRMATION: 'true',
            CLAUDE_AUTO_CONFIRM: 'yes',
            CLAUDE_NONINTERACTIVE: '1',
            CI: 'true',
            TERM: 'dumb'
          }
        });
        
        let stdout = '';
        let stderr = '';
        
        child.stdout?.on('data', (data) => {
          const output = data.toString();
          stdout += output;
          console.log('CLAUDE OUT:', output.trim());
        });
        
        child.stderr?.on('data', (data) => {
          const output = data.toString();
          stderr += output;
          console.log('CLAUDE ERR:', output.trim());
        });
        
        let processFinished = false;
        
        child.on('close', (code) => {
          if (!processFinished) {
            processFinished = true;
            console.log(`📊 Claude Code finished with code: ${code}`);
            resolve({ code, stdout, stderr });
          }
        });
        
        child.on('error', (error) => {
          if (!processFinished) {
            processFinished = true;
            console.log(`❌ Claude Code error: ${error.message}`);
            reject({ error: error.message });
          }
        });
        
        // Timeout
        const timeoutId = setTimeout(() => {
          if (!processFinished) {
            processFinished = true;
            console.log('⏰ Killing Claude Code due to timeout');
            child.kill('SIGTERM');
            resolve({ code: 'TIMEOUT', stdout, stderr });
          }
        }, 60000); // 1 minuto
        
        // Cancelar timeout se o processo terminar
        child.on('close', () => {
          clearTimeout(timeoutId);
        });
      });
      
      const executionTime = Math.floor((Date.now() - startTime) / 1000);
      const detailedOutput = `=== Claude Code Execution ===
Command: ${command}
Exit Code: ${result.code}
Execution Time: ${executionTime}s
=== STDOUT ===
${result.stdout}
=== STDERR ===
${result.stderr}
`;
      
      const success = result.code === 0;
      
      if (success) {
        resolve({
          success: true,
          detail: detailedOutput
        });
      } else if (result.code === 0) {
        resolve({
          success: false,
          detail: detailedOutput
        });
      } else {
        resolve({
          success: false,
          detail: detailedOutput
        });
      }
      
    } catch (setupError) {
      reject({
        success: false,
        command: command,
        error: 'Setup failed: ' + setupError.message,
      });
    }
  });
}

async function initializeLocalGit(projectPath) {
  const gitCommands = [
    `cd "${projectPath}" && git init`,
    `cd "${projectPath}" && git config user.email "claude-v2@webhook.com"`,
    `cd "${projectPath}" && git config user.name "Bot"`,
    `cd "${projectPath}" && echo "# Projeto Claude Code V2" > README.md`,
    `cd "${projectPath}" && git add README.md`,
    `cd "${projectPath}" && git commit -m "Initial commit"`
  ];

  for (const cmd of gitCommands) {
    try {
      await new Promise((resolve) => {
        exec(cmd, { timeout: 10000 }, () => resolve());
      });
    } catch (e) {
      console.warn('Git init command failed:', cmd);
    }
  }
}

async function createBranchAsync(projectPath, origin = 'main', branch) {
  try {
    console.log(`🌿 Criando branch ${branch} a partir de ${origin}...`);
    
    // Comandos sequenciais para garantir a criação correta da branch
    const commands = [
      // 1. Verificar se estamos em um repositório git
      `cd "${projectPath}" && git status`,
      
      // 2. Buscar atualizações do remote se existir
      `cd "${projectPath}" && (git fetch origin 2>/dev/null || echo "No remote to fetch")`,
      
      // 3. Verificar se a branch origin existe localmente
      `cd "${projectPath}" && git show-ref --verify --quiet refs/heads/${origin}`,
      
      // 4. Se origin não existe localmente, verificar se existe no remote
      `cd "${projectPath}" && (git show-ref --verify --quiet refs/remotes/origin/${origin} && git checkout -b ${origin} origin/${origin} || echo "Origin branch not found in remote")`,
      
      // 5. Se origin ainda não existe, criar a partir de main
      `cd "${projectPath}" && (git show-ref --verify --quiet refs/heads/${origin} || (git checkout main 2>/dev/null && git checkout -b ${origin} && git push -u origin ${origin} 2>/dev/null || echo "Created origin branch locally"))`,
      
      // 6. Fazer checkout da origin
      `cd "${projectPath}" && git checkout ${origin}`,
      
      // 7. Criar a nova branch a partir da origin
      `cd "${projectPath}" && (git checkout -b ${branch} 2>/dev/null || git checkout ${branch})`,
      
      // 8. Push da nova branch para o remote se existir
      `cd "${projectPath}" && (git push -u origin ${branch} 2>/dev/null || echo "No remote to push to")`
    ];
    
    for (const cmd of commands) {
      await new Promise((resolve) => {
        exec(cmd, { timeout: 15000 }, (error, stdout, stderr) => {
          if (error && !cmd.includes('||')) {
            console.warn(`⚠️ Command failed: ${cmd.split('&&').pop()?.trim()}`);
            console.warn(`Error: ${error.message}`);
          } else {
            console.log(`✅ Command completed: ${cmd.split('&&').pop()?.trim()}`);
            if (stdout && stdout.trim()) {
              console.log(`Output: ${stdout.trim()}`);
            }
          }
          resolve();
        });
      });
    }
    
    console.log(`✅ Branch ${branch} criada com sucesso a partir de ${origin}`);
    
  } catch (e) {
    console.warn('Branch setup failed:', e.message);
    
    // Fallback: criar branch simples se tudo falhar
    try {
      await new Promise((resolve) => {
        const fallbackCmd = `cd "${projectPath}" && git checkout -b ${branch}`;
        exec(fallbackCmd, { timeout: 10000 }, () => {
          console.log(`⚠️ Fallback: Branch ${branch} criada diretamente`);
          resolve();
        });
      });
    } catch (fallbackError) {
      console.warn('Branch creation completely failed:', fallbackError.message);
    }
  }
}

async function commitChanges(projectPath, instruction, branch = 'main') {
  try {
    const commitMessage = `feat: ${instruction.substring(0, 72)}${instruction.length > 72 ? '...' : ''}\n\nGenerated by: Claude Code`;
    
    // Comandos sequenciais para garantir que tudo está configurado
    const commands = [
      // Garantir que estamos no branch correto
      `cd "${projectPath}" && git checkout ${branch} 2>/dev/null || git checkout -b ${branch}`,
      // Adicionar arquivos
      `cd "${projectPath}" && git add .`,
      // Fazer commit
      `cd "${projectPath}" && git commit -m "${commitMessage}" || echo "No changes to commit"`,
      // Push do branch se há remote
      `cd "${projectPath}" && (git remote get-url origin >/dev/null 2>&1 && git push -u origin ${branch} || echo "No remote configured")`
    ];
    
    for (const cmd of commands) {
      await new Promise((resolve) => {
        exec(cmd, { timeout: 30000 }, (error, stdout, stderr) => {
          if (error) {
            console.warn(`⚠️ Command failed: ${cmd.split('&&').pop()?.trim()}`);
            console.warn(`Error: ${error.message}`);
          } else {
            console.log(`✅ Command completed: ${cmd.split('&&').pop()?.trim()}`);
          }
          resolve();
        });
      });
    }
  } catch (e) {
    console.warn('Commit process failed:', e.message);
  }
}

async function createPullRequest(projectPath, origin = 'main', branch, title, description) {
  return new Promise(async (resolve, reject) => {
    try {
      // Primeiro verificar se há commits no branch
      const checkCommitsCmd = `cd "${projectPath}" && git rev-list --count ${branch}`;
      
      const commitCount = await new Promise((res) => {
        exec(checkCommitsCmd, { timeout: 10000 }, (error, stdout) => {
          if (error) {
            console.warn('Could not count commits, proceeding anyway');
            res('1'); 
          } else {
            res(stdout.trim());
          }
        });
      });
      
      if (commitCount === '0') {
        resolve({
          success: false,
          error: 'No commits found in branch',
          suggestion: 'Make sure changes were committed before creating PR'
        });
        return;
      }
      
      // Verificar se o remote existe
      const checkRemoteCmd = `cd "${projectPath}" && git remote get-url origin`;
      
      const hasRemote = await new Promise((res) => {
        exec(checkRemoteCmd, { timeout: 10000 }, (error, stdout) => {
          if (error) {
            console.warn('No remote origin configured');
            res(false);
          } else {
            console.log('Remote origin found:', stdout.trim());
            res(true);
          }
        });
      });
      
      if (!hasRemote) {
        resolve({
          success: false,
          error: 'No remote repository configured',
          suggestion: 'Cannot create PR without a remote repository'
        });
        return;
      }
      
      // Verificar diferenças entre branches
      const diffCmd = `cd "${projectPath}" && git diff --name-only ${origin}..${branch}`;
      
      const changedFiles = await new Promise((res) => {
        exec(diffCmd, { timeout: 10000 }, (error, stdout) => {
          if (error) {
            console.warn('Could not check diff, proceeding anyway');
            res(['unknown']);
          } else {
            res(stdout.trim().split('\n').filter(f => f.length > 0));
          }
        });
      });
      
      if (changedFiles.length === 0) {
        resolve({
          success: false,
          error: `No differences found between ${origin} and ${branch}`,
          suggestion: 'Make sure changes were committed and pushed'
        });
        return;
      }
           
      // Criar PR
      const prCmd = `cd "${projectPath}" && gh pr create --title "${title}" --body "${description}" --head ${branch} --base ${origin}`;
      
      exec(prCmd, {
        timeout: 30000,
        env: {
          ...process.env,
          GH_TOKEN: process.env.GITHUB_TOKEN
        }
      }, (error, stdout, stderr) => {
        if (error) {
          resolve({
            success: false,
            error: error.message,
            stderr: stderr,
            debug: {
              commitCount,
              hasRemote,
              changedFiles
            }
          });
        } else {
          resolve({
            success: true,
            prUrl: stdout.trim(),
            message: 'PR criado com sucesso',
            changedFiles: changedFiles
          });
        }
      });
      
    } catch (setupError) {
      resolve({
        success: false,
        error: 'PR setup failed: ' + setupError.message
      });
    }
  });
}

app.post('/execute-claude', async (req, res) => {
  try {
    const {
      instruction,
      repoUrl,
      projectName,
      branch = 'feat/claude-auto-generate',
      origin = 'main',
      createPR = true,
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
      ? `/tmp/projects/${projectName}-v2`
      : `/tmp/projects/claude-v2-project`;

    console.log(`🚀 Claude Code V2 - Nova implementação`);
    console.log(`📝 Instrução: ${instruction}`);
    console.log(`📁 Projeto: ${projectPath}`);

    // Preparar repositório se fornecido
    if (repoUrl) {
      try {
        await ensureRepository(repoUrl, projectPath);
      } catch (repoError) {
        return res.status(400).json({
          success: false,
          error: 'Erro ao preparar repositório: ' + repoError.message
        });
      }
    } else {
      // Criar diretório local
      await fs.mkdir(projectPath, { recursive: true });
      await initializeLocalGit(projectPath);
    }

    await createBranchAsync(projectPath, origin, branch);
    const result = await executeClaudeCode(instruction, projectPath);
    let prResult = null;

    if (result.success) {
      await commitChanges(projectPath, instruction, branch);

      if (createPR && process.env.GITHUB_TOKEN && repoUrl) {
        try {
          prResult = await createPullRequest(
            projectPath,
            origin,
            branch,
            prTitle || `feat: ${instruction.substring(0, 50)}...`,
            prDescription || `Implementação via Claude Code:\n\n${instruction}}`
          );
        } catch (prError) {
          console.warn('Erro ao criar PR:', prError);
          prResult = { success: false, error: prError.message };
        }
      }
    }

    res.json({
      success: true,
      result: {
        claudeCode: result,
        pullRequest: prResult,
        branch: branch,
        projectPath: projectPath,
        timestamp: new Date().toISOString()
      },
      summary: {
        instruction: instruction,
        pr_created: !!prResult?.success
      }
    });

  } catch (error) {
    console.error('Erro no Claude Code', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Erro interno do servidor'
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

  // Verificar Claude Code - MELHORADO para detectar ambos os comandos
  const claudeCommands = ['claude-code', 'claude'];
  let claudeFound = false;
  
  for (const cmd of claudeCommands) {
    try {
      const claudePath = await new Promise((resolve, reject) => {
        exec(`which ${cmd}`, (error, stdout) => {
          if (error) reject(error);
          else resolve(stdout.trim());
        });
      });
      
      const claudeVersion = await new Promise((resolve, reject) => {
        exec(`${cmd} --version`, { timeout: 10000 }, (error, stdout) => {
          if (error) reject(error);
          else resolve(stdout.trim());
        });
      });
      
      diagnostics.installations[`claude_${cmd.replace('-', '_')}`] = {
        status: 'installed',
        path: claudePath,
        version: claudeVersion,
        command: cmd
      };
      
      claudeFound = true;
      
      // Se encontrou, marcar como preferido
      if (!diagnostics.installations.claude_preferred) {
        diagnostics.installations.claude_preferred = {
          command: cmd,
          path: claudePath,
          version: claudeVersion
        };
      }
      
    } catch (error) {
      diagnostics.installations[`claude_${cmd.replace('-', '_')}`] = {
        status: 'not_found',
        error: error.message,
        command: cmd
      };
    }
  }
  
  // Se nenhum comando foi encontrado, procurar em locais alternativos
  if (!claudeFound) {
    const possiblePaths = [
      '/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude-code',
      '/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude',
      '/app/node_modules/.bin/claude-code',
      '/app/node_modules/.bin/claude',
      '/usr/local/bin/claude'
    ];
    
    diagnostics.installations.claude_alternative_search = [];
    
    for (const path of possiblePaths) {
      try {
        require('fs').accessSync(path);
        diagnostics.installations.claude_alternative_search.push({
          path: path,
          exists: true,
          executable: require('fs').constants.X_OK
        });
      } catch (e) {
        diagnostics.installations.claude_alternative_search.push({
          path: path,
          exists: false,
          error: e.code
        });
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
    
    // Verificar /usr/local/lib/node_modules/@anthropic-ai/claude-code/
    try {
      const claudeModulePath = '/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin';
      if (fs.existsSync(claudeModulePath)) {
        const claudeBinContents = fs.readdirSync(claudeModulePath);
        diagnostics.file_system.claude_module_bin = claudeBinContents;
      }
    } catch (e) {
      diagnostics.file_system.claude_module_error = e.message;
    }
    
  } catch (error) {
    diagnostics.file_system.error = error.message;
  }

  // Adicionar recomendações baseadas nos resultados - MELHORADO
  diagnostics.recommendations = [];
  
  if (!claudeFound && !diagnostics.installations.claude_preferred) {
    diagnostics.recommendations.push({
      type: 'error',
      message: 'Claude Code não está disponível em nenhum comando (claude-code ou claude)',
      action: 'Execute POST /fix-claude para tentar corrigir automaticamente'
    });
  } else if (claudeFound) {
    diagnostics.recommendations.push({
      type: 'success',
      message: `Claude Code disponível como: ${diagnostics.installations.claude_preferred?.command}`,
      action: 'Pronto para uso!'
    });
  }
    
  if (!diagnostics.environment.env_vars.has_webhook_secret) {
    diagnostics.recommendations.push({
      type: 'warning',
      message: 'WEBHOOK_SECRET não configurado',
      action: 'Configurar WEBHOOK_SECRET para segurança'
    });
  }
  
  if (diagnostics.installations.github_cli?.status === 'installed') {
    const authStatus = diagnostics.installations.github_cli.auth_status;
    if (authStatus.includes('Missing required token scopes')) {
      diagnostics.recommendations.push({
        type: 'warning',
        message: 'GitHub token não tem todos os scopes necessários',
        action: 'Execute: gh auth refresh -h github.com para adicionar scopes'
      });
    } else if (authStatus.includes('Logged in')) {
      diagnostics.recommendations.push({
        type: 'success',
        message: 'GitHub CLI configurado e autenticado',
        action: 'PRs automáticos funcionarão'
      });
    }
  } else {
    diagnostics.recommendations.push({
      type: 'info',
      message: 'GitHub CLI não disponível',
      action: 'PRs automáticos não funcionarão sem GitHub CLI'
    });
  }

  // Status geral
  diagnostics.overall_status = {
    claude_ready: claudeFound,
    git_configured: diagnostics.installations.git?.status === 'installed',
    webhook_ready: claudeFound,
    pr_ready: diagnostics.installations.github_cli?.status === 'installed' && !!process.env.GITHUB_TOKEN
  };

  res.json(diagnostics);
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
