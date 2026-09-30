import express from 'express';
import cors from 'cors';
import { clerkMiddleware, getAuth } from '@clerk/express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  mcpAuthClerk,
  streamableHttpHandler
} from '@clerk/mcp-tools/express';

import {
  allowedPluginUserIds,
  registerVaelonsMcpTools
} from '../lib/plugin-mcp-core.js';

const app = express();

function publishableKey() {
  return (
    process.env.CLERK_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||
    ''
  ).trim();
}

function pluginAuthReady() {
  return Boolean(
    publishableKey() &&
      process.env.CLERK_SECRET_KEY &&
      process.env.PLUGIN_ALLOWED_CLERK_USER_IDS
  );
}

function createServer() {
  const server = new McpServer({
    name: 'VAELONS Etsy Manager',
    version: '1.0.0'
  });

  registerVaelonsMcpTools(server);
  return server;
}

function requirePluginConfiguration(_req, res, next) {
  if (!pluginAuthReady()) {
    return res.status(503).json({
      error: 'plugin_auth_not_configured',
      etsy_modified: false
    });
  }

  next();
}

function requireAllowedOwner(req, res, next) {
  const auth = getAuth(req, { acceptsToken: 'oauth_token' });
  const userId = auth?.userId ? String(auth.userId) : '';

  if (!auth?.isAuthenticated || !userId || !allowedPluginUserIds().has(userId)) {
    return res.status(403).json({
      error: 'plugin_user_not_allowed',
      etsy_modified: false
    });
  }

  next();
}

app.use(
  cors({
    origin: true,
    methods: ['POST', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Mcp-Session-Id'],
    exposedHeaders: ['WWW-Authenticate', 'Mcp-Session-Id']
  })
);
app.use(express.json({ limit: '2mb' }));
app.use(requirePluginConfiguration);
app.use(
  clerkMiddleware({
    publishableKey: publishableKey(),
    secretKey: process.env.CLERK_SECRET_KEY
  })
);

app.post(
  '/api/mcp',
  mcpAuthClerk,
  requireAllowedOwner,
  streamableHttpHandler(createServer)
);

app.get('/api/mcp', (_req, res) => {
  res.set('Allow', 'POST, OPTIONS').status(405).json({
    error: 'method_not_allowed',
    etsy_modified: false
  });
});

export default app;
