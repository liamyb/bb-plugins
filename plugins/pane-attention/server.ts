// No backend: everything happens in app.tsx. The server entry only declares
// the setting.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export default function paneAttention(bb: BbPluginApi): void {
  bb.settings.define({
    families: {
      type: "boolean",
      label: "Mark thread families in split panes",
      description:
        "A child thread's pane, and its parent's when that's open too, share a colour taken from the family's top thread, and the child's header names its parent. Clicking the name opens the parent beside the child, or focuses it if it's open. The Sandbar theme draws the colour. Off: panes look as bb draws them.",
      default: true,
    },
  });
}
