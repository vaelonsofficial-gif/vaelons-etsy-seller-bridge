import { clerkMiddleware } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';

function clerkConfigured() {
  return Boolean(
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY
  );
}

export default async function middleware(request, event) {
  if (!clerkConfigured()) {
    return NextResponse.next();
  }

  return clerkMiddleware()(request, event);
}

export const config = {
  matcher: [
    '/mcp',
    '/.well-known/:path*',
    '/__clerk/:path*'
  ]
};
