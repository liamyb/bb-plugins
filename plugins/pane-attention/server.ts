// No backend. Everything happens in app.tsx, but bb requires a server entry.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export default function paneAttention(_bb: BbPluginApi): void {}
