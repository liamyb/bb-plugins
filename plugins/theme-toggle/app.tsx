// Theme Toggle: one button in the sidebar footer, and Cmd+Option+T, that
// switch bb between two themes (Sandbar and Mixtape unless the settings say
// otherwise). bb's theme is server-wide, so switching in one window
// switches every window and device, exactly as Settings > Appearance does.
//
// The footer button and the command run outside React, so a tiny overlay
// in each window keeps the SDK client and the two settings where they can
// reach them.
import { useEffect } from "react";
import { definePluginApp, useSdk, useSettings } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { DEFAULT_FIRST, DEFAULT_SECOND, nextTheme, themeSetting } from "./src/toggle";

type Sdk = ReturnType<typeof useSdk>;

const live: { sdk: Sdk | null; first: string; second: string; busy: boolean } = {
  sdk: null,
  first: DEFAULT_FIRST,
  second: DEFAULT_SECOND,
  busy: false,
};

async function toggleTheme(): Promise<void> {
  const sdk = live.sdk;
  if (sdk === null || live.busy) return;
  live.busy = true;
  let target = live.second;
  try {
    const active = await sdk.theme.get();
    target = nextTheme(active.themeId, live.first, live.second);
    await sdk.theme.set(target);
  } catch (error) {
    const reason = (error instanceof Error ? error.message : String(error)).trim();
    const sentence = reason === "" ? "" : /[.!?]$/.test(reason) ? `${reason} ` : `${reason}. `;
    toast.error(`Couldn't switch to the "${target}" theme`, {
      description: `${sentence}Check it's listed by \`bb theme list\`, or change the theme ids in Theme Toggle's settings.`,
    });
  } finally {
    live.busy = false;
  }
}

function Keeper(): null {
  const sdk = useSdk();
  const { values } = useSettings();
  useEffect(() => {
    live.sdk = sdk;
    live.first = themeSetting(values?.first, DEFAULT_FIRST);
    live.second = themeSetting(values?.second, DEFAULT_SECOND);
    return () => {
      if (live.sdk === sdk) live.sdk = null;
    };
  }, [sdk, values]);
  return null;
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({
    id: "theme-toggle",
    component: Keeper,
  });
  app.commands.register({
    id: "toggle",
    title: "Theme Toggle: switch to the other theme",
    defaultShortcut: { key: "t", mod: true, alt: true },
    run: () => toggleTheme(),
  });
  app.experimental_sidebarFooter.register({
    kind: "action",
    id: "toggle",
    label: "Switch theme (⌥⌘T)",
    icon: "Palette",
    onActivate: () => toggleTheme(),
  });
});
