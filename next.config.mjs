/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  images: {
    unoptimized: true,
  },
  // Ensure all routes are statically exported
  trailingSlash: true,
  turbopack: {
    root: import.meta.dirname,
  },
};

export default nextConfig;
