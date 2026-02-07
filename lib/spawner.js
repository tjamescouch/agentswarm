/**
 * Spawner
 * Creates isolated workspaces and agent identities for swarm members.
 * Invoked by the supervisor at startup and when scaling up.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

// Default workspace base
const DEFAULT_BASE_PATH = path.join(process.env.HOME || '.', 'dev', 'claude');

/**
 * Generate an Ed25519 keypair for an agentchat identity.
 * Returns { publicKey, privateKey } in PEM format.
 */
function generateIdentity(name) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const agentId = crypto.createHash('sha256').update(publicKey).digest('hex').substring(0, 8);

  return {
    publicKey,
    privateKey,
    agentId,
    name,
    created: new Date().toISOString(),
  };
}

/**
 * Default .gitignore for agent workspaces.
 * Written before any other files per invariant.
 */
const DEFAULT_GITIGNORE = `# Security — no secrets in workspace
*.key
*.pem
.env
.env.*
credentials.json
*.credential
*.secret

# Node
node_modules/

# OS
.DS_Store
Thumbs.db
`;

/**
 * Default CLAUDE.md template.
 * @param {object} opts
 * @param {string} opts.role - agent role
 * @param {string} opts.agentId - agentchat agent ID
 * @param {string[]} opts.channels - assigned channels
 * @param {string} [opts.extraInstructions] - additional role-specific instructions
 */
function buildClaudeMd({ role, agentId, channels, extraInstructions }) {
  const lines = [
    `# Agent: ${role}`,
    '',
    `AgentChat identity: @${agentId}`,
    `Channels: ${channels.join(', ')}`,
    '',
    '## Role',
    '',
    `You are a swarm agent with role "${role}". Follow instructions from the supervisor.`,
    `Report status to your assigned channels.`,
  ];

  if (extraInstructions) {
    lines.push('', '## Additional Instructions', '', extraInstructions);
  }

  return lines.join('\n') + '\n';
}

export class Spawner {
  /**
   * @param {object} [options]
   * @param {string} [options.basePath] - base directory for workspaces
   */
  constructor(options = {}) {
    this.basePath = options.basePath || DEFAULT_BASE_PATH;
    this.workspaces = new Map(); // agentId -> workspace path
  }

  /**
   * Spawn a new agent workspace and identity.
   *
   * @param {object} config
   * @param {string} config.name - agent name (e.g., "swarm-builder-001")
   * @param {string} [config.role] - agent role (default: "builder")
   * @param {string} [config.repo] - git repo URL to clone
   * @param {string} [config.branch] - branch name to create (default: swarm/<name>/main)
   * @param {string[]} [config.channels] - agentchat channels (default: ["#agents"])
   * @param {string} [config.extraInstructions] - additional CLAUDE.md instructions
   * @param {string} [config.context] - initial context.md content
   * @returns {{ workspace: string, identity: object, agentId: string }}
   */
  spawn(config) {
    const {
      name,
      role = 'builder',
      repo,
      branch,
      channels = ['#agents'],
      extraInstructions,
      context,
    } = config;

    if (!name || typeof name !== 'string') {
      throw new Error('spawn requires a name');
    }

    const workspace = path.join(this.basePath, name);

    // Check workspace doesn't already exist
    if (fs.existsSync(workspace)) {
      throw new Error(`Workspace already exists: ${workspace}`);
    }

    // Create workspace directory
    fs.mkdirSync(workspace, { recursive: true });

    // Invariant: .gitignore written BEFORE any other files
    fs.writeFileSync(path.join(workspace, '.gitignore'), DEFAULT_GITIGNORE);

    // Clone repo if specified
    if (repo) {
      execFileSync('git', ['clone', repo, '.'], { cwd: workspace, stdio: 'pipe' });
      // Create feature branch
      const branchName = branch || `swarm/${name}/main`;
      execFileSync('git', ['checkout', '-b', branchName], { cwd: workspace, stdio: 'pipe' });
    } else {
      // Init a new git repo
      execFileSync('git', ['init'], { cwd: workspace, stdio: 'pipe' });
    }

    // Generate agentchat identity
    const identity = generateIdentity(name);
    const identityDir = path.join(workspace, '.agentchat', 'identities');
    fs.mkdirSync(identityDir, { recursive: true });
    fs.writeFileSync(
      path.join(identityDir, `${name}.json`),
      JSON.stringify(identity, null, 2)
    );

    // Write CLAUDE.md
    const claudeMd = buildClaudeMd({
      role,
      agentId: identity.agentId,
      channels,
      extraInstructions,
    });
    fs.writeFileSync(path.join(workspace, 'CLAUDE.md'), claudeMd);

    // Write context.md
    const contextContent = context || `# Context\n\nAgent: ${name}\nRole: ${role}\nCreated: ${new Date().toISOString()}\n`;
    fs.writeFileSync(path.join(workspace, 'context.md'), contextContent);

    // Track workspace
    this.workspaces.set(identity.agentId, workspace);

    return {
      workspace,
      identity: {
        agentId: identity.agentId,
        name: identity.name,
        publicKey: identity.publicKey,
      },
      agentId: identity.agentId,
    };
  }

  /**
   * Tear down an agent workspace.
   * Requires explicit confirmation (confirm=true).
   *
   * @param {string} agentId - the agent ID to remove
   * @param {object} [options]
   * @param {boolean} [options.confirm] - must be true to proceed
   * @returns {{ success: boolean, workspace?: string, error?: string }}
   */
  teardown(agentId, options = {}) {
    if (!options.confirm) {
      return { success: false, error: 'teardown requires explicit confirmation (confirm: true)' };
    }

    const workspace = this.workspaces.get(agentId);
    if (!workspace) {
      return { success: false, error: `Unknown agent: ${agentId}` };
    }

    if (!fs.existsSync(workspace)) {
      this.workspaces.delete(agentId);
      return { success: false, error: `Workspace not found on disk: ${workspace}` };
    }

    fs.rmSync(workspace, { recursive: true, force: true });
    this.workspaces.delete(agentId);

    return { success: true, workspace };
  }

  /**
   * List all tracked workspaces.
   * @returns {Array<{ agentId: string, workspace: string, exists: boolean }>}
   */
  list() {
    const result = [];
    for (const [agentId, workspace] of this.workspaces) {
      result.push({
        agentId,
        workspace,
        exists: fs.existsSync(workspace),
      });
    }
    return result;
  }
}

export { generateIdentity, DEFAULT_GITIGNORE, buildClaudeMd };
