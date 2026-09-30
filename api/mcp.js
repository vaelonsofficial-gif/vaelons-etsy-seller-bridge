import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerVaelonsMcpToolsV2 } from '../lib/plugin-mcp-v2.js';

const AUTH_SERVER = 'https://etsy-price-manager.vercel.app';
const INTROSPECTION_URL = `${AUTH_SERVER}/api/plugin/oauth/introspect`;
const REQUIRED_SCOPES = ['vaelons:read', 'vaelons:write'];

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

function requestOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return `${proto}://${host}`;
}

function resourceUrl(req) {
  return `${requestOrigin(req)}/api/mcp`;
}

function metadataUrl(req) {
  return `${requestOrigin(req)}/.well-known/oauth-protected-resource/api/mcp`;
}

function applyCors(res) {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Session-Id',
    'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id',
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex'
  });
}

function authFailure(req, res, error, description, status = 401) {
  applyCors(res);
  const safeDescription = String(description || 'OAuth authentication required').replace(/["\\]/g, '');
  res.set(
    'WWW-Authenticate',
    `Bearer resource_metadata="${metadataUrl(req)}", error="${error}", error_description="${safeDescription}", scope="${REQUIRED_SCOPES.join(' ')}"`
  );
  return res.status(status).json({
    error,
    error_description: safeDescription,
    etsy_modified: false
  });
}

function bearerToken(req) {
  const authorization = String(req.headers.authorization || '');
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

async function authenticate(req, res) {
  const token = bearerToken(req);
  if (!token) {
    authFailure(req, res, 'invalid_token', 'OAuth access token is required.');
    return null;
  }

  let response;
  try {
    response = await fetch(INTROSPECTION_URL, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`
      },
      cache: 'no-store'
    });
  } catch {
    authFailure(req, res, 'temporarily_unavailable', 'OAuth token validation is temporarily unavailable.', 503);
    return null;
  }

  let identity = null;
  try {
    identity = await response.json();
  } catch {
    identity = null;
  }

  const expectedResource = resourceUrl(req);
  if (
    !response.ok ||
    !identity?.active ||
    identity?.iss !== AUTH_SERVER ||
    identity?.resource !== expectedResource ||
    identity?.aud !== expectedResource
  ) {
    authFailure(req, res, 'invalid_token', 'OAuth token is invalid for this VAELONS MCP resource.');
    return null;
  }

  const scopes = String(identity.scope || '')
    .split(/\s+/)
    .filter(Boolean);
  const granted = new Set(scopes);
  const missing = REQUIRED_SCOPES.filter((scope) => !granted.has(scope));
  if (missing.length) {
    authFailure(req, res, 'insufficient_scope', `Required scope missing: ${missing.join(' ')}`);
    return null;
  }

  return {
    accessToken: token,
    scopes,
    identity,
    origin: requestOrigin(req),
    resourceMetadata: metadataUrl(req)
  };
}

function createServer(context) {
  const server = new McpServer({
    name: 'VAELONS Etsy Manager',
    version: '1.0.0'
  });
  registerVaelonsMcpToolsV2(server, context);
  return server;
}

app.options('/api/mcp', (_req, res) => {
  applyCors(res);
  res.status(204).end();
});

app.post('/api/mcp', async (req, res) => {
  applyCors(res);
  const context = await authenticate(req, res);
  if (!context || res.headersSent) return;

  const server = createServer(context);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });

  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: error?.message || 'MCP request failed.'
        },
        id: null
      });
    }
  }
});

app.get('/api/mcp', (_req, res) => {
  applyCors(res);
  res.set('Allow', 'POST, OPTIONS').status(405).json({
    error: 'method_not_allowed',
    etsy_modified: false
  });
});

app.delete('/api/mcp', (_req, res) => {
  applyCors(res);
  res.set('Allow', 'POST, OPTIONS').status(405).json({
    error: 'method_not_allowed',
    etsy_modified: false
  });
});

export default app;
