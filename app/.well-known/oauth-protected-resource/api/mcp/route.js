import { generateClerkProtectedResourceMetadata } from '@clerk/mcp-tools/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function publishableKey() {
  return (
    process.env.CLERK_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||
    ''
  ).trim();
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

export async function GET(request) {
  const key = publishableKey();
  if (!key) {
    return Response.json(
      { error: 'plugin_auth_not_configured', etsy_modified: false },
      { status: 503, headers: corsHeaders }
    );
  }

  const resourceUrl = new URL('/api/mcp', request.url).toString();
  const metadata = generateClerkProtectedResourceMetadata({
    publishableKey: key,
    resourceUrl,
    scopes_supported: ['openid', 'profile', 'email']
  });

  return Response.json(metadata, { headers: corsHeaders });
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}
