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

// Função para instalar Claude Code se necessário
async function ensureClaudeCode() {
  return new Promise((resolve, reject) => {
    // Primeiro, verificar se existe como 'claude-code'
    exec('which claude-code', (error1, stdout1) => {
      if (!error1) {
        console.log('✅ claude-code já disponível em:', stdout1.trim());
        resolve('claude-code');
        return;
      }
      
      // Verificar se existe como 'claude' (nome alternativo)
      exec('which claude', (error2, stdout2) => {
        if (!error2) {
          console.log('✅ claude disponível em:', stdout2.trim());
          console.log('💡 Usando "claude" em vez de "claude-code"');
          resolve('claude');
          return;
        }
        
        // Verificar se existe no node_modules global
        const possiblePaths = [
          '/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude-code',
          '/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude',
          '/app/node_modules/.bin/claude-code',
          '/app/node_modules/.bin/claude'
        ];
        
        for (const path of possiblePaths) {
          try {
            require('fs').accessSync(path);
            console.log('✅ Claude encontrado em:', path);
            // Criar symlink
            exec(`ln -sf ${path} /usr/local/bin/claude-code`, (linkError) => {
              if (linkError) {
                console.warn('⚠️ Não foi possível criar symlink, mas executável encontrado');
              }
              resolve('claude-code');
            });
            return;
          } catch (e) {
            // Continue procurando
          }
        }
        
        console.log('📦 Claude Code não encontrado. Tentando reinstalar...');
        
        // Tentar instalar
        exec('npm install -g @anthropic-ai/claude-code --unsafe-perm=true --allow-root', {
          timeout: 60000 // 1 minuto timeout
        }, (installError, installStdout, installStderr) => {
          if (installError) {
            console.error('❌ Erro ao reinstalar Claude Code:', installError.message);
            console.error('stderr:', installStderr);
            reject(installError);
            return;
          }
          
          console.log('✅ Claude Code reinstalado');
          
          // Verificar se funciona agora
          exec('which claude-code || which claude', (finalError, finalStdout) => {
            if (finalError) {
              reject(new Error('Claude Code instalado mas ainda não encontrado no PATH'));
            } else {
              const command = finalStdout.trim().includes('claude-code') ? 'claude-code' : 'claude';
              console.log('✅ Claude disponível como:', command);
              resolve(command);
            }
          });
        });
      });
    });
  });
}

// Função principal para executar Claude Code
async function executeClaudeCode(instruction, projectPath, options = {}) {
  return new Promise(async (resolve, reject) => {
    const {
      branch = 'feat/generate-automatic',
      createBranch = true,
      createPR = false
    } = options;

    // Garantir que Claude Code está disponível e descobrir o comando correto
    let claudeCommand;
    try {
      claudeCommand = await ensureClaudeCode();
    } catch (error) {
      reject({
        success: false,
        error: 'Falha ao garantir que Claude Code está disponível: ' + error.message,
        suggestion: 'Problema na instalação do Claude Code no container'
      });
      return;
    }

    console.log(`🤖 Usando comando: ${claudeCommand}`);
    console.log(`📁 Diretório do projeto: ${projectPath}`);
    console.log(`🌿 Branch: ${branch}`);

    // Verificar se o diretório existe
    try {
      await fs.access(projectPath);
    } catch {
      reject({
        success: false,
        error: `Diretório do projeto não encontrado: ${projectPath}`,
        suggestion: 'Certifique-se de que o repositório foi clonado corretamente'
      });
      return;
    }

    // Dividir em comandos menores para evitar timeout
    const commands = [];
    
    // 1. Configurar Git
    commands.push({
      name: 'git_config',
      cmd: `cd "${projectPath}" && git config user.email "emingues@gmail.com" && git config user.name "Bot"`,
      timeout: 10000
    });
    
    // 2. Fetch origin (se for repositório clonado)
    commands.push({
      name: 'git_fetch',
      cmd: `cd "${projectPath}" && git fetch origin || echo "No remote origin"`,
      timeout: 30000
    });
    
    // 3. Criar/trocar branch
    if (createBranch) {
      commands.push({
        name: 'git_branch',
        cmd: `cd "${projectPath}" && (git checkout -b ${branch} 2>/dev/null || git checkout ${branch} || git checkout -b ${branch})`,
        timeout: 15000
      });
    }
    
    // 4. Executar Claude Code com diagnóstico melhorado
    commands.push({
      name: 'claude_test',
      cmd: `${claudeCommand} --version`,
      timeout: 15000
    });

    commands.push({
      name: 'claude_code',
      cmd: `cd "${projectPath}" && timeout 180s ${claudeCommand} "${instruction}"`,
      timeout: 200000 // 3.3 minutos (um pouco mais que o timeout interno)
    });

    // Executar comandos sequencialmente
    let results = [];
    
    for (const command of commands) {
      console.log(`⚡ Executando: ${command.name}`);
      
      try {
        const result = await new Promise((resolve, reject) => {
          exec(command.cmd, {
            timeout: command.timeout,
            env: {
              ...process.env,
              ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
              PATH: '/usr/local/bin:/usr/bin:/bin',
              // Debug adicional
              DEBUG: '1',
              ANTHROPIC_DEBUG: '1'
            }
          }, (error, stdout, stderr) => {
            if (error) {
              // Para alguns comandos, erro não é crítico
              if (command.name === 'git_fetch' && error.code !== 143) {
                console.warn(`⚠️ ${command.name} failed but continuing:`, error.message);
                resolve({ stdout: '', stderr: error.message, warning: true });
                return;
              }
              reject(error);
            } else {
              resolve({ stdout, stderr, success: true });
            }
          });
        });
        
        results.push({ 
          command: command.name, 
          ...result 
        });
        
        console.log(`✅ ${command.name} completed`);
        
      } catch (error) {
        console.error(`❌ ${command.name} failed:`, error.message);
        
        // Se Claude Code falhou, é erro crítico
        if (command.name === 'claude_code') {
          reject({
            success: false,
            error: `${command.name} failed: ${error.message}`,
            stderr: error.stderr || '',
            results: results,
            debug: {
              command: command.cmd.replace(process.env.ANTHROPIC_API_KEY || '', '***'),
              timeout: command.timeout,
              code: error.code
            }
          });
          return;
        }
        
        // Para outros comandos, continua com warning
        results.push({ 
          command: command.name, 
          error: error.message, 
          failed: true 
        });
      }
    }
    
    // Sucesso se chegou até aqui
    const claudeResult = results.find(r => r.command === 'claude_code' && r.success) || 
                        results.find(r => r.command === 'claude_fallback' && r.success);
    
    if (!claudeResult || !claudeResult.success) {
      reject({
        success: false,
        error: 'Nenhum método de execução do Claude Code funcionou',
        results: results,
        suggestion: 'Problema grave com conectividade da API ou configuração'
      });
      return;
    }
    
    resolve({
      success: true,
      stdout: claudeResult.stdout || '',
      stderr: claudeResult.stderr || '',
      branch: branch,
      projectPath: projectPath,
      claudeCommand: claudeCommand,
      method_used: claudeResult.command,
      allResults: results
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

// Função para forçar Claude Code CLI com múltiplas estratégias
async function forceClaudeCodeCLI(instruction, projectPath, options = {}) {
  return new Promise(async (resolve, reject) => {
    const {
      branch = 'feat/generate-automatic',
      createBranch = true
    } = options;

    console.log('💪 FORÇANDO uso do Claude Code CLI...');
    
    // Detectar comando Claude
    let claudeCommand;
    try {
      claudeCommand = await ensureClaudeCode();
    } catch (error) {
      reject({
        success: false,
        error: 'Claude Code não disponível: ' + error.message
      });
      return;
    }

    // ESTRATÉGIA 3: Instrução fragmentada
    console.log('🔧 Estratégia 3: Instrução fragmentada');
    try {
      const strategy3 = await executeWithStrategy3(claudeCommand, instruction, projectPath);
      if (strategy3.success) {
        console.log('✅ Estratégia 3 FUNCIONOU!');
        return resolve(strategy3);
      }
    } catch (e3) {
      console.log('❌ Estratégia 3 falhou:', e3.message);
    }

    // ESTRATÉGIA 4: Processo separado + kill forçado
    console.log('🔧 Estratégia 4: Processo separado + kill forçado');
    try {
      const strategy4 = await executeWithStrategy4(claudeCommand, instruction, projectPath);
      if (strategy4.success) {
        console.log('✅ Estratégia 4 FUNCIONOU!');
        return resolve(strategy4);
      }
    } catch (e4) {
      console.log('❌ Estratégia 4 falhou:', e4.message);
    }

    // ESTRATÉGIA 5: Reinstalar Claude Code
    console.log('🔧 Estratégia 5: Reinstalar Claude Code');
    try {
      const strategy5 = await executeWithStrategy5(claudeCommand, instruction, projectPath);
      if (strategy5.success) {
        console.log('✅ Estratégia 5 FUNCIONOU!');
        return resolve(strategy5);
      }
    } catch (e5) {
      console.log('❌ Estratégia 5 falhou:', e5.message);
    }

    // Se todas falharam
    reject({
      success: false,
      error: 'Todas as 5 estratégias de força falharam',
      strategies_tried: 5,
      final_message: 'Claude Code CLI é impossível de forçar neste ambiente'
    });
  });
}

// ESTRATÉGIA 1: Timeout muito longo + debug máximo
async function executeWithStrategy1(claudeCommand, instruction, projectPath) {
  return new Promise((resolve, reject) => {
    console.log('⏰ Timeout de 10 minutos + debug máximo');
    
    const cmd = `cd "${projectPath}" && ${claudeCommand} "${instruction}"`;
    
    exec(cmd, {
      timeout: 600000, // 10 minutos!!
      maxBuffer: 50 * 1024 * 1024, // 50MB buffer
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        DEBUG: '*',
        ANTHROPIC_DEBUG: '1',
        CLAUDE_DEBUG: '1',
        NODE_DEBUG: '*',
        VERBOSE: '1'
      }
    }, (error, stdout, stderr) => {
      if (error) {
        reject({ success: false, error: error.message, code: error.code });
      } else {
        resolve({ 
          success: true, 
          stdout, 
          stderr, 
          strategy: '1_long_timeout',
          timeout_used: '10min'
        });
      }
    });
  });
}

// ESTRATÉGIA 2: Reiniciar + limpar cache
async function executeWithStrategy2(claudeCommand, instruction, projectPath) {
  return new Promise(async (resolve, reject) => {
    console.log('🧹 Limpando cache e reiniciando...');
    
    // Limpar possíveis caches
    const cleanupCmds = [
      'npm cache clean --force',
      'rm -rf ~/.npm/_cacache',
      'rm -rf /tmp/claude-*',
      'killall node || true',
      'killall claude || true'
    ];
    
    for (const cleanCmd of cleanupCmds) {
      try {
        await new Promise((res) => {
          exec(cleanCmd, { timeout: 10000 }, () => res()); // Ignora erros
        });
      } catch (e) {
        // Ignora erros de limpeza
      }
    }
    
    // Aguardar um pouco
    await new Promise(res => setTimeout(res, 2000));
    
    // Tentar executar
    const cmd = `cd "${projectPath}" && stdbuf -oL -eL ${claudeCommand} "${instruction}"`;
    
    exec(cmd, {
      timeout: 180000, // 3 minutos
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        PATH: '/usr/local/bin:/usr/bin:/bin'
      }
    }, (error, stdout, stderr) => {
      if (error) {
        reject({ success: false, error: error.message, code: error.code });
      } else {
        resolve({ 
          success: true, 
          stdout, 
          stderr, 
          strategy: '2_restart_cleanup'
        });
      }
    });
  });
}

// ESTRATÉGIA 3: Instrução fragmentada
async function executeWithStrategy3(claudeCommand, instruction, projectPath) {
  return new Promise(async (resolve, reject) => {
    console.log('✂️ Fragmentando instrução...');
    
    // Quebrar instrução em partes menores
    const fragments = instruction.length > 50 
      ? [instruction.substring(0, 50), instruction.substring(50)]
      : [instruction];
    
    let allResults = [];
    
    for (let i = 0; i < fragments.length; i++) {
      const fragment = fragments[i];
      const isLast = i === fragments.length - 1;
      
      console.log(`📝 Fragmento ${i + 1}/${fragments.length}: ${fragment}`);
      
      const cmd = `cd "${projectPath}" && echo "${fragment}" | ${claudeCommand} --stdin`;
      
      try {
        const result = await new Promise((resolve, reject) => {
          exec(cmd, {
            timeout: 90000, // 1.5 minutos por fragmento
            env: {
              ...process.env,
              ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY
            }
          }, (error, stdout, stderr) => {
            if (error) {
              reject(error);
            } else {
              resolve({ stdout, stderr });
            }
          });
        });
        
        allResults.push(result);
        
        if (isLast) {
          resolve({
            success: true,
            stdout: allResults.map(r => r.stdout).join('\n'),
            stderr: allResults.map(r => r.stderr).join('\n'),
            strategy: '3_fragmented',
            fragments_used: fragments.length
          });
          return;
        }
        
      } catch (fragmentError) {
        if (isLast && allResults.length > 0) {
          // Se último fragmento falhou mas temos resultados anteriores
          resolve({
            success: true,
            stdout: allResults.map(r => r.stdout).join('\n'),
            stderr: `Partial success: ${allResults.length}/${fragments.length} fragments`,
            strategy: '3_fragmented_partial'
          });
          return;
        }
        reject({ success: false, error: fragmentError.message });
        return;
      }
    }
  });
}

// ESTRATÉGIA 4: Processo separado + kill forçado
async function executeWithStrategy4(claudeCommand, instruction, projectPath) {
  return new Promise((resolve, reject) => {
    console.log('⚡ Processo separado + kill automático');
    
    const cmd = `cd "${projectPath}" && timeout --preserve-status 120s ${claudeCommand} "${instruction}"`;
    
    const child = exec(cmd, {
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY
      }
    }, (error, stdout, stderr) => {
      if (error && error.code !== 143) { // 143 é timeout, que esperamos
        reject({ success: false, error: error.message, code: error.code });
      } else {
        resolve({ 
          success: true, 
          stdout: stdout || 'Process completed (may have been killed)',
          stderr, 
          strategy: '4_separate_process',
          was_killed: error?.code === 143
        });
      }
    });
    
    // Kill forçado após 2 minutos
    setTimeout(() => {
      if (child.pid) {
        console.log('💀 Matando processo forçadamente...');
        try {
          process.kill(child.pid, 'SIGKILL');
        } catch (e) {
          console.log('Processo já morto ou não existe');
        }
      }
    }, 120000);
  });
}

// ESTRATÉGIA 5: Reinstalar Claude Code
async function executeWithStrategy5(claudeCommand, instruction, projectPath) {
  return new Promise(async (resolve, reject) => {
    console.log('🔄 Reinstalando Claude Code...');
    
    // Remover instalação atual
    try {
      await new Promise((res) => {
        exec('npm uninstall -g @anthropic-ai/claude-code', { timeout: 30000 }, () => res());
      });
    } catch (e) {
      console.log('Remoção falhou, continuando...');
    }
    
    // Reinstalar
    try {
      await new Promise((resolve, reject) => {
        exec('npm install -g @anthropic-ai/claude-code --unsafe-perm=true --allow-root --force', {
          timeout: 120000 // 2 minutos para reinstalar
        }, (error, stdout, stderr) => {
          if (error) {
            reject(error);
          } else {
            console.log('✅ Claude Code reinstalado');
            resolve(stdout);
          }
        });
      });
    } catch (reinstallError) {
      reject({ success: false, error: 'Falha na reinstalação: ' + reinstallError.message });
      return;
    }
    
    // Tentar executar com versão reinstalada
    const newCommand = await ensureClaudeCode();
    const cmd = `cd "${projectPath}" && ${newCommand} "${instruction}"`;
    
    exec(cmd, {
      timeout: 180000, // 3 minutos
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY
      }
    }, (error, stdout, stderr) => {
      if (error) {
        reject({ success: false, error: error.message, code: error.code });
      } else {
        resolve({ 
          success: true, 
          stdout, 
          stderr, 
          strategy: '5_reinstall',
          reinstalled: true
        });
      }
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
    console.log(`Repository: ${repoUrl}`);

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
    const result = await forceClaudeCodeCLI(instruction, projectPath, {
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

// Endpoint para testar conectividade com API Anthropic
app.post('/test-api', async (req, res) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.json({
        success: false,
        error: 'ANTHROPIC_API_KEY não configurada'
      });
    }

    console.log('🧪 Testando conectividade com API Anthropic...');

    // Teste direto com curl para API Anthropic
    const apiTest = await new Promise((resolve) => {
      const testCmd = `curl -s -w "HTTPSTATUS:%{http_code}" -X POST "https://api.anthropic.com/v1/messages" \
        -H "Content-Type: application/json" \
        -H "x-api-key: ${process.env.ANTHROPIC_API_KEY}" \
        -H "anthropic-version: 2023-06-01" \
        -d '{"model": "claude-3-haiku-20240307", "max_tokens": 10, "messages": [{"role": "user", "content": "hi"}]}' \
        --connect-timeout 10 --max-time 30`;

      exec(testCmd, (error, stdout, stderr) => {
        if (error) {
          resolve({
            success: false,
            error: error.message,
            stderr: stderr
          });
        } else {
          // Separar response do HTTP status
          const parts = stdout.split('HTTPSTATUS:');
          const response = parts[0];
          const httpStatus = parts[1];

          resolve({
            success: true,
            http_status: httpStatus,
            response: response,
            api_accessible: httpStatus === '200'
          });
        }
      });
    });

    // Teste com Claude Code para ver logs detalhados
    const claudeCommand = await ensureClaudeCode().catch(e => 'claude');
    
    const claudeTest = await new Promise((resolve) => {
      const testDir = `/tmp/api-test-${Date.now()}`;
      exec(`mkdir -p ${testDir}`, () => {
        exec(`cd ${testDir} && timeout 45s ${claudeCommand} "create a simple hello.txt file" --verbose`, {
          env: {
            ...process.env,
            ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
            ANTHROPIC_DEBUG: '1',
            DEBUG: '1'
          }
        }, (error, stdout, stderr) => {
          // Cleanup
          exec(`rm -rf ${testDir}`);
          
          resolve({
            success: !error,
            stdout: stdout || '',
            stderr: stderr || '',
            error: error ? error.message : null,
            code: error ? error.code : null
          });
        });
      });
    });

    res.json({
      success: apiTest.api_accessible && claudeTest.success,
      tests: {
        direct_api: apiTest,
        claude_code: claudeTest
      },
      api_key_info: {
        configured: true,
        length: process.env.ANTHROPIC_API_KEY.length,
        prefix: process.env.ANTHROPIC_API_KEY.substring(0, 10) + '...'
      },
      recommendations: apiTest.api_accessible ? 
        (claudeTest.success ? 
          ['Tudo OK! API acessível e Claude Code funcionando'] :
          ['API OK mas Claude Code com problema - verifique logs']
        ) : 
        ['API Anthropic inacessível - verifique API key ou conectividade']
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
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
  
  if (!diagnostics.environment.env_vars.has_anthropic_key) {
    diagnostics.recommendations.push({
      type: 'error',
      message: 'ANTHROPIC_API_KEY não configurada',
      action: 'Configurar a variável de ambiente ANTHROPIC_API_KEY no Railway'
    });
  } else if (diagnostics.environment.env_vars.anthropic_key_length < 100) {
    diagnostics.recommendations.push({
      type: 'warning',
      message: 'ANTHROPIC_API_KEY parece ser muito curta',
      action: 'Verificar se a API key está completa'
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
    api_key_configured: !!process.env.ANTHROPIC_API_KEY,
    git_configured: diagnostics.installations.git?.status === 'installed',
    webhook_ready: claudeFound && !!process.env.ANTHROPIC_API_KEY,
    pr_ready: diagnostics.installations.github_cli?.status === 'installed' && !!process.env.GITHUB_TOKEN
  };

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
