import { loadAgents } from "../lib/config.ts";
import { handleDesktop } from "../lib/desktop.ts";
import { BlobState } from "../lib/state.ts";

export default { fetch: (request: Request) => handleDesktop(request, loadAgents(), new BlobState()) };
