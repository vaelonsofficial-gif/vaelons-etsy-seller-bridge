export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const AUTH_SERVER = 'https://etsy-price-manager.vercel.app';
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Cache-Control': 'no-store'
};

export async function GET(request) {
  const resource = new URL('/api/mcp', request.url).toString();
  return Response.json(
    {
      resource,
      authorization_servers: [AUTH_SERVER],
      scopes_supported: ['vaelons:read', 'vaelons:write', 'offline_access'],
      bearer_methods_supported: ['header']
    },
    { headers: corsHeaders }
  );
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}
