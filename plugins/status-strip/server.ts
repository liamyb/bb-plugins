// No backend: everything happens in app.tsx. The server entry only declares
// the settings.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export default function statusStrip(bb: BbPluginApi): void {
  bb.settings.define({
    everyTheme: {
      type: "boolean",
      label: "Show the strip in every theme",
      description:
        "Off: the strip shows only in themes that ask for it (Mixtape does, with --status-strip: on). On: it shows above every thread's composer whatever the theme.",
      default: false,
    },
    markWindow: {
      type: "boolean",
      label: "Mark the window while agents work",
      description:
        "Sets data-agents-running on the page while any thread is working, so a theme can react. Mixtape uses it to animate its level meter only while something runs.",
      default: true,
    },
  });
}
