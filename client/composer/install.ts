/**
 * Settings -> Messages -> Rich composer: every Paseo composer on the page gets
 * a rich editor (`bridge.ts`), web and desktop only.
 *
 * Paseo mounts several composers at once (split panes, hidden retained tabs,
 * the draft and New workspace composers) and remounts a textarea when the
 * layout crosses its compact breakpoint, so the page is watched rather than
 * any one composer: each textarea that appears gets its own bridge, and a
 * bridge whose textarea left the document is taken down.
 *
 * The editor's code is in the Tasks chunk (`tasks/chunk/entry.ts`), out of the
 * bundle phones download on every reconnect; composers stay plain until it
 * arrives, shortly after startup.
 */
import { Platform } from "react-native";
import { chunkNow, requestChunkLater, subscribeChunk } from "../tasks/chunk/load";

const COMPOSER_TEXTAREA = "textarea[data-composer-input]";

export function installRichComposer(): () => void {
  if (Platform.OS !== "web" || typeof document === "undefined") return () => {};
  const bridges = new Map<HTMLTextAreaElement, () => void>();
  let frame = 0;

  const scan = () => {
    frame = 0;
    const attachRichComposer = chunkNow()?.attachRichComposer;
    if (!attachRichComposer) return;
    for (const [textarea, detach] of bridges) {
      if (textarea.isConnected) continue;
      detach();
      bridges.delete(textarea);
    }
    document.querySelectorAll<HTMLTextAreaElement>(COMPOSER_TEXTAREA).forEach((textarea) => {
      if (bridges.has(textarea)) return;
      try {
        bridges.set(textarea, attachRichComposer(textarea));
      } catch (error) {
        // That composer stays Paseo's plain textarea.
        console.warn("[better-paseo] rich composer could not attach", error);
      }
    });
  };
  const schedule = () => {
    if (frame === 0) frame = requestAnimationFrame(scan);
  };

  // Typing in an editor mutates the page too; only changes elsewhere can add
  // or remove a composer.
  const observer = new MutationObserver((records) => {
    if (records.some((record) => !(record.target as Element).closest?.("[data-bp-rich-composer]"))) schedule();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  const stopChunk = subscribeChunk(schedule);
  // Once startup settles, like the sidebar's Tasks row: the first chat rows come first.
  if (!chunkNow()) requestChunkLater();
  scan();

  return () => {
    stopChunk();
    observer.disconnect();
    if (frame !== 0) cancelAnimationFrame(frame);
    for (const detach of bridges.values()) detach();
    bridges.clear();
  };
}
