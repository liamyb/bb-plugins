// Settings only. Everything else happens in app.tsx.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export default function paneKeeper(bb: BbPluginApi): void {
  bb.settings.define({
    notificationClicks: {
      type: "boolean",
      label: "Notification clicks open beside the focused pane",
      description:
        "Needs the Notifications Pro hook from this repo's patches folder. Off: a click opens over the focused pane, as Notifications Pro does on its own.",
      default: true,
    },
    atPaneLimit: {
      type: "select",
      label: "At 8 panes (bb's limit)",
      description:
        "replace-oldest swaps out the pane you used least recently, never the focused one or one Pane Attention has flagged. notice opens nothing and says so.",
      options: ["replace-oldest", "notice"],
      default: "replace-oldest",
    },
  });
}
