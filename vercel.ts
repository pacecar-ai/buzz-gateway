import type { VercelConfig } from "@vercel/config/v1";

const region = process.env.BUZZ_GATEWAY_REGION ?? process.env.VERCEL_REGION;
if (!region || !/^[a-z]{3}\d$/.test(region)) {
  throw new Error("Set BUZZ_GATEWAY_REGION to the region shared by your daemon, Functions, and Blob store");
}

export const config = {
  git: { deploymentEnabled: false },
  outputDirectory: "public",
  regions: [region],
  daemons: {
    "buzz-gateway": { root: ".", entrypoint: "daemon/Dockerfile", instances: { [region]: 1 } },
  },
} satisfies VercelConfig & { daemons: Record<string, { root: string; entrypoint: string; instances: Record<string, number> }> };
