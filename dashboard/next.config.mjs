/** @type {import('next').NextConfig} */
const nextConfig = {
  // Allow NEXT_PUBLIC_WS_URL to be injected at build time via Vercel env vars
  env: {
    NEXT_PUBLIC_WS_URL: process.env.NEXT_PUBLIC_WS_URL ?? '',
  },
};

export default nextConfig;
