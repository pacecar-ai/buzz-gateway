import { execFileSync } from "node:child_process";
import { setTimeout as pause } from "node:timers/promises";

const {
  VERCEL_TOKEN: token,
  VERCEL_ORG_ID: teamId,
  VERCEL_PROJECT_ID: projectId,
  GITHUB_SHA: expectedCommit,
  GITHUB_RUN_ID: workflowRun,
} = process.env;

if (!token || !teamId || !projectId) {
  throw new Error("Set VERCEL_TOKEN, VERCEL_ORG_ID, and VERCEL_PROJECT_ID for the deployment job");
}

async function vercel(path, body) {
  const url = new URL(path, "https://api.vercel.com");
  url.searchParams.set("teamId", teamId);
  const response = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = data.error?.code;
    throw new Error(`Vercel ${response.status} for ${path}${code ? ` (${code})` : ""}`);
  }
  return data;
}

const git = args => execFileSync("git", args, { maxBuffer: 8 * 1024 * 1024 });
const commit = git(["rev-parse", "HEAD"]).toString().trim();
if (expectedCommit && commit !== expectedCommit) throw new Error("Checked-out commit does not match the CI run");

const project = await vercel(`/v9/projects/${encodeURIComponent(projectId)}`);
if (project.id !== projectId || typeof project.name !== "string") throw new Error("Vercel project ID did not match");

const paths = git(["ls-tree", "-r", "--name-only", "-z", commit]).toString().split("\0").filter(Boolean);
const files = paths.map(file => ({
  file,
  encoding: "base64",
  data: git(["cat-file", "blob", `${commit}:${file}`]).toString("base64"),
}));

const release = await vercel("/v13/deployments?skipAutoDetectionConfirmation=1", {
  name: project.name,
  project: projectId,
  target: "production",
  files,
  meta: { gitCommitSha: commit, ...(workflowRun ? { githubActionsRunId: workflowRun } : {}) },
});
if (typeof release.id !== "string") throw new Error("Vercel did not return a deployment ID");
console.log(`Created production deployment ${release.id} for ${commit}`);

const deadline = Date.now() + 12 * 60_000;
while (Date.now() < deadline) {
  const deployment = await vercel(`/v13/deployments/${encodeURIComponent(release.id)}`);
  if (["ERROR", "CANCELED"].includes(deployment.readyState) || deployment.aliasError) {
    const detail = deployment.errorCode ?? deployment.aliasError?.code ?? deployment.readyState;
    throw new Error(`Vercel deployment ${release.id} failed (${detail})`);
  }
  if (deployment.readyState === "READY" && deployment.aliasAssigned) {
    console.log(`Production deployment ready at https://${deployment.url}`);
    process.exit(0);
  }
  await pause(5000);
}
throw new Error(`Timed out waiting for production deployment ${release.id}`);
