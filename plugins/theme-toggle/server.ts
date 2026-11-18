// No backend: the switch happens in app.tsx. The server entry only declares
// the settings.
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
        "The theme id the toggle switches to. From any theme it isn't set to go round, the toggle goes here; from this one, it goes back to the first, or on to the third if that's set.",
      default: "mixtape",
    },
    third: {
      type: "string",
      label: "Third theme (optional)",
      description:
        "Leave blank to flip between two themes. Set a theme id here and the toggle goes round all three in order: first, second, third, then the first again.",
      default: "",
    },
  });
}
