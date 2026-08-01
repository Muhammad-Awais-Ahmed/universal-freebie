/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  images: {
    unoptimized: true,
  },
  // Ensure all routes are statically exported
  trailingSlash: true,
};

export default nextConfig;
