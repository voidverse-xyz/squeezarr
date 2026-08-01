/** @type {import('next').NextConfig} */

// Dev-only API proxy: `next dev` runs the UI on :3000 and proxies /api to the Express backend
// (default :4000) so the browser stays same-origin and there's no CORS. In the production build
// (`next build` → static export) this rewrite is absent — Express serves both UI and /api.
const BACKEND_PORT = process.env.BACKEND_PORT || 4000;
const isDev = process.env.NODE_ENV === "development";

const nextConfig = {
    // Pure static client: the backend owns all data/state, the UI is prebuilt HTML/JS/CSS that
    // Express serves. No custom server, no Next API routes.
    output: "export",
    reactCompiler: true,
    images: { unoptimized: true },
    // `shared` is a plain-ESM workspace package; let Next bundle it.
    transpilePackages: ["shared"],
    ...(isDev && {
        async rewrites() {
            return [{ source: "/api/:path*", destination: `http://localhost:${BACKEND_PORT}/api/:path*` }];
        },
    }),
};

export default nextConfig;
