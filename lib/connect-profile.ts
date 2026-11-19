import { getVercelOidcToken } from "@vercel/oidc";
import { z } from "zod";

const metadata = z.object({
  name: z.string().trim().min(1),
  icon: z.string().regex(/^[a-f0-9]{40}$/).nullish(),
});

export async function readConnectProfile(connector: string): Promise<{ name: string; picture?: string }> {
  const response = await fetch(`https://api.vercel.com/v1/connect/connectors/${encodeURIComponent(connector)}`, {
    headers: { accept: "application/json", authorization: `Bearer ${await getVercelOidcToken()}` },
    signal: AbortSignal.timeout(8000),
    redirect: "error",
  });
  if (!response.ok) throw new Error("Vercel Connect could not read the Buzz profile");
  const { name, icon } = metadata.parse(await response.json());
  return {
    name: name.replace(/ · Buzz$/, ""),
    picture: icon ? `https://vercel.com/api/www/avatar/${icon}` : undefined,
  };
}
