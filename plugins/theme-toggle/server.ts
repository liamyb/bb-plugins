// No backend: the switch happens in app.tsx. The server entry only declares
// the two settings.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export default function themeToggle(bb: BbPluginApi): void {
  bb.settings.define({
    first: {
      type: "string",
      label: "First theme",
      description:
        "The theme id the toggle goes back to, as `bb theme list` shows it. A custom theme's id is its folder name.",
      default: "sandbar",
    },
    second: {
      type: "string",
      label: "Second theme",
      description:
        "The theme id the toggle switches to. From any theme other than this one, the toggle goes here; from this one, it goes back to the first.",
      default: "mixtape",
    },
  });
}
