/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // @meshsdk/core ships WebAssembly (cardano-serialization internals).
  webpack: (config) => {
    config.experiments = {
      ...config.experiments,
      asyncWebAssembly: true,
      layers: true,
    };
    return config;
  },
};

export default nextConfig;
