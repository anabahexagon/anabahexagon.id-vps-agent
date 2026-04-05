require('dotenv').config();
const { io } = require('socket.io-client');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const si = require('systeminformation');

const HELPER_URL = process.env.HELPER_URL || 'http://localhost:3005';
const SERVER_ID = process.env.SERVER_ID;
const AGENT_TOKEN = process.env.AGENT_TOKEN;

if (!SERVER_ID || !AGENT_TOKEN) {
  console.error('Error: SERVER_ID and AGENT_TOKEN must be set in .env');
  process.exit(1);
}

const socket = io(`${HELPER_URL}/agent`, {
  auth: { token: AGENT_TOKEN, serverId: SERVER_ID },
  reconnection: true
});

console.log(`[${new Date().toISOString()}] Connecting to ${HELPER_URL}/agent...`);

socket.on('connect', () => {
  console.log('Successfully connected to Helper');
  startMetricsCollection();
});

socket.on('connect_error', (err) => {
  console.error('Connection error:', err.message);
});

socket.on('deploy-task', (data, callback) => {
  const { deployPath, buildScript, branch, deploymentId, repoUrl } = data;
  
  console.log(`\n[${new Date().toISOString()}] >>> TASK RECEIVED (ID: ${deploymentId})`);
  console.log(`- Repo: ${repoUrl}`);
  console.log(`- Branch: ${branch}`);
  console.log(`- Path: ${deployPath}`);

  if (typeof callback === 'function') {
    callback({ success: true });
  }

  let allLogs = "";
  
  const runCommand = (cmd, args, cwd, timeoutMs = 600000) => {
    return new Promise((resolve, reject) => {
      const fullCommand = args.length > 0 ? `${cmd} ${args.join(' ')}` : cmd;
      console.log(`[EXEC]: ${fullCommand}`);
      
      try {
        const proc = spawn(fullCommand, [], { 
          cwd, 
          shell: true,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } 
        });
        
        const timer = setTimeout(() => {
          console.log(`[TIMEOUT]: ${fullCommand}`);
          if (process.platform === 'win32') {
             // Paksa matikan seluruh pohon proses di Windows jika timeout
             spawn('taskkill', ['/F', '/T', '/PID', proc.pid]);
          } else {
             proc.kill('SIGKILL');
          }
          reject(new Error(`Command timed out after ${timeoutMs/1000}s: ${fullCommand}`));
        }, timeoutMs);

        proc.stdout.on('data', (d) => {
          const str = d.toString();
          allLogs += str;
          process.stdout.write(str);
          socket.emit('deploy-log', { serverId: SERVER_ID, data: str });
        });

        proc.stderr.on('data', (d) => {
          const str = d.toString();
          allLogs += str;
          process.stderr.write(str);
          socket.emit('deploy-log', { serverId: SERVER_ID, data: str, isError: true });
        });

        proc.on('error', (err) => {
          console.error(`[SPAWN ERROR]: ${err.message}`);
          clearTimeout(timer);
          reject(err);
        });

        proc.on('close', (code) => {
          clearTimeout(timer);
          if (code === 0) {
            console.log(`[DONE]: ${fullCommand}`);
            resolve();
          } else {
            console.log(`[FAILED]: ${fullCommand} (Exit code: ${code})`);
            reject(new Error(`Command failed with exit code ${code}`));
          }
        });
      } catch (e) {
        console.error(`[INTERNAL ERROR]: ${e.message}`);
        reject(e);
      }
    });
  };

  const startDeploy = async () => {
    try {
      console.log("Starting deployment process...");
      const startMsg = `\n--- START DEPLOYMENT (ID: ${deploymentId}) ---\n`;
      allLogs += startMsg;
      socket.emit('deploy-log', { serverId: SERVER_ID, data: startMsg });

      if (!fs.existsSync(deployPath)) {
        console.log(`Path doesn't exist, creating: ${deployPath}`);
        fs.mkdirSync(deployPath, { recursive: true });
      }

      const isGitRepo = fs.existsSync(path.join(deployPath, '.git'));
      if (!isGitRepo) {
        console.log("Not a git repo, cloning...");
        const cloneUrl = `https://github.com/${repoUrl}.git`;
        await runCommand('git', ['clone', '-b', branch, cloneUrl, '.'], deployPath);
      } else {
        console.log("Existing repo found, pulling...");
        await runCommand('git', ['fetch', 'origin', branch], deployPath);
        await runCommand('git', ['reset', '--hard', `origin/${branch}`], deployPath);
      }

      if (buildScript) {
        console.log("Running build script...");
        const scriptLines = buildScript.split('\n').filter(l => l.trim());
        for (const line of scriptLines) {
           await runCommand(line.trim(), [], deployPath);
        }
      }

      console.log("Deployment finished successfully!");
      const successMsg = `\n--- DEPLOYMENT SUCCESSFUL ---\n`;
      allLogs += successMsg;
      socket.emit('deploy-log', { serverId: SERVER_ID, data: successMsg });

      // Save to local file
      saveLogToFile(deploymentId, allLogs);

      if (deploymentId) {
        socket.emit('deploy-result', { deploymentId, status: 'success', logs: allLogs });
      }
    } catch (error) {
      console.error('CRITICAL DEPLOYMENT FAILURE:', error);
      const failMsg = `\n--- DEPLOYMENT FAILED: ${error.message} ---\n`;
      allLogs += failMsg;
      socket.emit('deploy-log', { serverId: SERVER_ID, data: failMsg, isError: true });

      // Save to local file even on failure
      saveLogToFile(deploymentId, allLogs);

      if (deploymentId) {
        socket.emit('deploy-result', { deploymentId, status: 'failed', logs: allLogs });
      }
    }
  };

  const saveLogToFile = (id, content) => {
    try {
      const logDir = path.join(__dirname, 'logs');
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);
      const fileName = `deploy-${id || 'unknown'}-${Date.now()}.log`;
      fs.writeFileSync(path.join(logDir, fileName), content);
      console.log(`[LOG SAVED]: ${fileName}`);
    } catch (err) {
      console.error('Failed to save log to file:', err.message);
    }
  };

  startDeploy().catch(err => console.error("Global startDeploy error:", err));
});

let metricsInterval;
function startMetricsCollection() {
  console.log("Starting metrics collection...");
  if (metricsInterval) clearInterval(metricsInterval);
  
  metricsInterval = setInterval(async () => {
    try {
      const [cpu, mem, fsSize] = await Promise.all([
        si.currentLoad(),
        si.mem(),
        si.fsSize()
      ]);

      const metrics = {
        serverId: SERVER_ID,
        cpu: cpu.currentLoad.toFixed(1),
        ram: {
          used: (mem.active / 1024 / 1024 / 1024).toFixed(2),
          total: (mem.total / 1024 / 1024 / 1024).toFixed(2),
          percent: ((mem.active / mem.total) * 100).toFixed(1)
        },
        disk: fsSize.length > 0 ? {
          used: (fsSize[0].used / 1024 / 1024 / 1024).toFixed(2),
          total: (fsSize[0].size / 1024 / 1024 / 1024).toFixed(2),
          percent: fsSize[0].use.toFixed(1)
        } : null,
        uptime: si.time().uptime
      };

      socket.emit('agent-metrics', metrics);
    } catch (err) {
      console.error("Failed to collect metrics:", err.message);
    }
  }, 5000);
}
