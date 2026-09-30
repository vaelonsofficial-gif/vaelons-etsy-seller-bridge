import { verifyClerkToken } from '@clerk/mcp-tools/next';
import { auth } from '@clerk/nextjs/server';
import { createMcpHandler, withMcpAuth } from 'mcp-handler';

import {
  allowedPluginUserIds,
  pluginAuthConfigured,
  registerVaelonsMcpTools
} from '../../lib/plugin-mcp-core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const handler = createMcpHandler((server) => {
  registerVaelonsMcpTools(server);
});

const authHandler = withMcpAuth(
  handler,
  async (_request, token) => {
    const clerkAuth = await auth({ acceptsToken: 'oauth_token' });
    const authInfo = await verifyClerkToken(clerkAuth, token);
    const userId = authInfo?.extra?.userId;

    if (!authInfo || !userId || !allowedPluginUserIds().has(String(userId))) {
      return undefined;
    }

    return authInfo;
  },
  {
    required: true,
    resourceMetadataPath: '/.well-known/oauth-protected-resource/mcp'
  }
);

async function guardedHandler(request) {
  if (!pluginAuthConfigured()) {
    return Response.json(
      {
        error: 'plugin_auth_not_configured',
        etsy_modified: false
      },
      { status: 503 }
    );
  }

  return authHandler(request);
}

export { guardedHandler as GET, guardedHandler as POST };
