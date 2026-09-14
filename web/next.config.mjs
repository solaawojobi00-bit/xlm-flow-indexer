/** @type {import('next').NextConfig} */
const nextConfig = {
  // `pg` resolves some of its driver internals dynamically. Leaving it external
  // keeps the bundler from trying to trace those requires statically.
  serverExternalPackages: ['pg'],

  // This app is a nested package inside the indexer repo, so Next sees more than
  // one lockfile and guesses a workspace root — on this machine it guessed the
  // home directory. Pinning it to `web/` keeps output file tracing correct.
  outputFileTracingRoot: import.meta.dirname,
};

export default nextConfig;
