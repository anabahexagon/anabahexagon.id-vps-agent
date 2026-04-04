require('dotenv').config();
const { io } = require('socket.io-client');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const HELPER_URL = process.env.HELPER_URL || 'http://localhost:3005';
const SERVER_ID = process.env.SERVER_ID;
const AGENT_TOKEN = process.env.AGENT_TOKEN;

if (!SERVER_ID || !AGENT_TOKEN) {
  console.error('Error: SERVER_ID and AGENT_TOKEN must be set in .env');
  process.exit(1);
}

const socket = io(`${HELPER_URL}/agent`, {
  auth: { token: AGENT_TOKEN, serverId: SERVER_ID }
});

console.log(`Connecting to ${HELPER_URL}/agent...`);

socket.on('connect', () => {
  console.log('Successfully connected to Helper');
});

socket.on('connect_error', (err) => {
  console.error('Connection error:', err.message);
});

socket.on('deploy-task', (data, callback) => {
  const { deployPath, buildScript, branch } = data;
  console.log(`Received deployment task for branch: ${branch} in ${deployPath}`);

  if (!fs.existsSync(deployPath)) {
    return callback({ success: false, error: `Deploy path does not exist: ${deployPath}` });
  }

  // Akui tugas diterima
  callback({ success: true });

  const runCommand = (cmd, args, cwd) => {
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, args, { cwd, shell: true });
      proc.stdout.on('data', (d) => socket.emit('deploy-log', { serverId: SERVER_ID, data: d.toString() }));
      proc.stderr.on('data', (d) => socket.emit('deploy-log', { serverId: SERVER_ID, data: d.toString(), isError: true }));
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Command failed with exit code ${code}: ${cmd} ${args.join(' ')}`));
      });
    });
  };

  const startDeploy = async () => {
    try {
      socket.emit('deploy-log', { serverId: SERVER_ID, data: `\n--- START DEPLOYMENT: Branch ${branch} ---\n` });

      // 1. Pull Code
      socket.emit('deploy-log', { serverId: SERVER_ID, data: `Step 1/2: Pulling code from origin/${branch}...\n` });
      await runCommand('git', ['pull', 'origin', branch], deployPath);

      // 2. Build & Deploy
      if (buildScript) {
        socket.emit('deploy-log', { serverId: SERVER_ID, data: `Step 2/2: Executing build script...\n` });
        const scriptLines = buildScript.split('\n').filter(l => l.trim());
        for (const line of scriptLines) {
           await runCommand(line, [], deployPath);
        }
      }

      socket.emit('deploy-log', { serverId: SERVER_ID, data: `\n--- DEPLOYMENT SUCCESSFUL ---\n` });
    } catch (error) {
      console.error('Deployment failed:', error);
      socket.emit('deploy-log', { serverId: SERVER_ID, data: `\n--- DEPLOYMENT FAILED: ${error.message} ---\n`, isError: true });
    }
  };

  startDeploy();
});
