// Message Times: puts the time Liam sent each of his messages beside its
// bubble in bb's thread timeline, with the full date and time on hover.
//
// bb renders a user row with an id of `${threadId}:user-seed:${seq}`, where
// seq is the client/turn/requested event behind it, but doesn't draw the
// time. This reads those events (and the matching turn/input/accepted, for
// steers) through the SDK and labels each row by that id, so it never
// depends on counting bubbles.
import { useEffect } from "react";
import { definePluginApp, useSdk } from "@get-bb/plugin-sdk/app";
import {
  emptyThreadTimes,
  EVENT_TYPES,
  formatDetail,
  formatShort,
  ingest,
  isSettled,
  parseUserRowId,
  shownAt,
  type RawEvent,
  type ThreadTimes,
} from "./src/times";
import {
  CSS,
  findBubble,
  labelFromEvent,
  onlyOurNodes,
  placeCard,
  removeAllLabels,
  removeLabel,
  setLabel,
  STYLE_ID,
  USER_ROW_SELECTOR,
} from "./src/dom";

const PAGE_SIZE = 100;
// bb's DOM changes constantly while an agent streams, so repaints are batched.
const PAINT_DELAY_MS = 100;
// Don't ask the server about the same thread more often than this, and back
// off for longer after an error.
const MIN_RELOAD_MS = 1_000;
const ERROR_BACKOFF_MS = 15_000;
// Re-format every minute, so "14:32" becomes "Yesterday 14:32" after midnight.
const TICK_MS = 60_000;
const STEER_WAIT_MS = 120_000;

type EventsClient = {
  list(input: {
    threadId: string;
    afterSeq?: string;
    limit?: string;
    order?: "asc" | "desc";
    types?: string[];
  }): Promise<unknown>;
};

function MessageTimes() {
  const sdk = useSdk();

  useEffect(() => {
    const events = (sdk as unknown as { threads: { events: EventsClient } }).threads.events;
    const cache = new Map<string, ThreadTimes>();
    const inflight = new Set<string>();
    const nextLoadAt = new Map<string, number>();
    let disposed = false;
    let paintTimer: ReturnType<typeof setTimeout> | undefined;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);

    async function load(threadId: string): Promise<void> {
      const times = cache.get(threadId) ?? emptyThreadTimes();
      cache.set(threadId, times);
      inflight.add(threadId);
      try {
        for (;;) {
          const page = await events.list({
            threadId,
            types: [...EVENT_TYPES],
            order: "asc",
            limit: String(PAGE_SIZE),
            ...(times.maxSeq > 0 ? { afterSeq: String(times.maxSeq) } : {}),
          });
          if (disposed) return;
          const rows = Array.isArray(page) ? (page as RawEvent[]) : [];
          ingest(times, rows);
          if (rows.length < PAGE_SIZE) break;
        }
        nextLoadAt.set(threadId, Date.now() + MIN_RELOAD_MS);
      } catch (error) {
        console.warn("[message-times] couldn't read events for", threadId, error);
        nextLoadAt.set(threadId, Date.now() + ERROR_BACKOFF_MS);
      } finally {
        inflight.delete(threadId);
      }
      schedulePaint();
    }

    function paint(): void {
      paintTimer = undefined;
      if (disposed) return;
      const now = Date.now();
      const needed = new Set<string>();
      for (const row of document.querySelectorAll(USER_ROW_SELECTOR)) {
        const parsed = parseUserRowId(row.getAttribute("data-timeline-row-id") ?? "");
        if (!parsed) continue;
        const entry = cache.get(parsed.threadId)?.bySeq.get(parsed.seq);
        // A steer that's never taken in (it failed, say) stops being asked
        // about after a couple of minutes.
        if (!entry || (!isSettled(entry) && now - entry.sentAt < STEER_WAIT_MS)) {
          needed.add(parsed.threadId);
        }
        if (!entry) continue;
        if (!entry.mine) {
          removeLabel(row);
          continue;
        }
        const bubble = findBubble(row);
        if (bubble) setLabel(document, bubble, formatShort(shownAt(entry), now), formatDetail(entry));
      }
      for (const threadId of needed) {
        if (inflight.has(threadId)) continue;
        const waitMs = (nextLoadAt.get(threadId) ?? 0) - now;
        if (waitMs > 0) {
          schedulePaint(waitMs);
          continue;
        }
        void load(threadId);
      }
    }

    function schedulePaint(delayMs = PAINT_DELAY_MS): void {
      if (disposed) return;
      if (paintTimer !== undefined) {
        if (delayMs > PAINT_DELAY_MS) return;
        clearTimeout(paintTimer);
      }
      paintTimer = setTimeout(paint, delayMs);
    }

    const observer = new MutationObserver((mutations) => {
      if (!onlyOurNodes(mutations)) schedulePaint();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const tick = setInterval(paint, TICK_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") schedulePaint();
    };
    document.addEventListener("visibilitychange", onVisible);
    const onPointerOver = (event: PointerEvent) => {
      const label = labelFromEvent(event);
      if (label) placeCard(label);
    };
    document.addEventListener("pointerover", onPointerOver, true);
    schedulePaint(0);

    return () => {
      disposed = true;
      observer.disconnect();
      clearInterval(tick);
      if (paintTimer !== undefined) clearTimeout(paintTimer);
      document.removeEventListener("visibilitychange", onVisible);
      document.removeEventListener("pointerover", onPointerOver, true);
      removeAllLabels(document);
      style.remove();
    };
  }, [sdk]);

  return null;
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({
    id: "message-times",
    component: MessageTimes,
  });
});
