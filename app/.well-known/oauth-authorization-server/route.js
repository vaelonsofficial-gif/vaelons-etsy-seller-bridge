import {
  authServerMetadataHandlerClerk,
  metadataCorsOptionsRequestHandler
} from '@clerk/mcp-tools/next';

import { pluginAuthConfigured } from '../../../lib/plugin-mcp-core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const corsHandler = metadataCorsOptionsRequestHandler();

export async function GET(request) {
  if (!pluginAuthConfigured()) {
    return Response.json(
      {
        error: 'plugin_auth_not_configured',
        etsy_modified: false
      },
      { status: 503 }
    );
  }

  const handler = authServerMetadataHandlerClerk();
  return handler(request);
}

export async function OPTIONS(request) {
  return corsHandler(request);
}
