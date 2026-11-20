/**
 * Puts a rich editor in place of one Paseo composer textarea (web only).
 *
 * Paseo keeps owning the textarea: its value is the prompt, its key handler
 * sends, recalls and drives autocomplete, its paste handler takes images. The
 * textarea is hidden but stays in the composer, and the bridge keeps the two
 * in step:
 *
 * - Editor to textarea: every change is written as Markdown text through the
 *   prototype value setter plus an `input` event, the path a keystroke takes
 *   (a bare `.value =` would be swallowed by React's value tracker).
 * - Textarea to editor: Paseo writes the textarea directly (clear after send,
 *   recall, autocomplete, dictation, rewind, plugin `setPrompt`), so the
 *   instance's `value` setter and `setSelectionRange` are wrapped, and each
 *   write is read back into the editor.
 * - Keys Paseo handles (Enter, ArrowUp/Down, Tab, Escape on a slash command)
 *   are offered to the textarea first; the editor acts only when Paseo leaves
 *   the event alone.
 * - Image pastes go to the textarea's paste listener; text is pasted as
 *   literal lines, as claude.ai does.
 * - `focus()`/`blur()` on the textarea move focus to the editor, and the
 *   editor's focus changes are reported as focusin/focusout on the textarea.
 *
 * Paseo reads `document.activeElement === textarea` in a few places (a plugin's
 * `composer.focus()` promise among them); those still see the editor as
 * unfocused. See docs/limitations.md.
 */
import { EditorState, EditorView, Slice, TextSelection, type Transaction } from "../vendor/prosemirror";
import { composerPlugins } from "./editor";
import {
  literalDoc,
  serializeFragment,
  offsetForPos,
  parseComposerText,
  posForOffset,
  serializeComposer,
  type TextSegment,
} from "./markdown";

const STYLE_ID = "bp-rich-composer-style";

/**
 * Event a composer textarea with an editor answers by inserting `text` (Markdown)
 * in place of the text offsets [start, end); it cancels the event when done.
 */
export const RICH_COMPOSER_INSERT = "bp-rich-composer-insert";
export interface RichComposerInsert {
  text: string;
  start: number;
  end: number;
}
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

const STYLE = `
.bp-rc{position:relative;outline:none;white-space:pre-wrap;overflow-wrap:break-word;word-break:break-word;font-variant-ligatures:none;overflow-y:auto;box-sizing:border-box;cursor:text;}
.bp-rc p{margin:0;}
.bp-rc ul,.bp-rc ol{margin:0;padding-left:1.6em;}
.bp-rc ul{list-style-type:disc;}
.bp-rc ul ul{list-style-type:circle;}
.bp-rc ul ul ul{list-style-type:square;}
.bp-rc li{margin:0;}
.bp-rc li::marker{color:var(--bp-rc-muted);}
.bp-rc code{font-family:${MONO};font-size:0.9em;padding:0.1em 0.3em;border-radius:4px;background:color-mix(in srgb,currentColor 10%,transparent);}
.bp-rc pre{margin:4px 0;padding:8px 10px;border-radius:8px;font-family:${MONO};font-size:0.9em;line-height:1.5;white-space:pre-wrap;background:color-mix(in srgb,currentColor 9%,transparent);}
.bp-rc pre code{padding:0;border-radius:0;background:none;font-size:inherit;}
.bp-rc s{text-decoration:line-through;}
.bp-rc.bp-rc-empty::before{content:attr(data-placeholder);position:absolute;pointer-events:none;color:var(--bp-rc-placeholder);}
.bp-rc[contenteditable=false]{cursor:default;}
`;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = STYLE;
  document.head.appendChild(style);
}

/** The keys Paseo's composer acts on, offered to it before the editor. */
function offeredToHost(event: KeyboardEvent, text: string, selectionEmpty: boolean): boolean {
  if (event.isComposing || event.keyCode === 229) return false;
  switch (event.key) {
    case "Enter":
      return true;
    case "ArrowUp":
    case "ArrowDown":
      return selectionEmpty && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey;
    case "Tab":
      // Shift+Tab is Paseo's mode cycle; its global shortcut already saw the key.
      return !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey;
    case "Escape":
      // Paseo's own Escape shortcut (interrupt) already saw the original key;
      // the textarea only needs it to clear a slash command.
      return text.startsWith("/");
    default:
      return false;
  }
}

/** Calls the textarea's React `onSelect`, which feeds Paseo's autocomplete its cursor. */
function reportSelection(textarea: HTMLTextAreaElement): void {
  const key = Object.keys(textarea).find((name) => name.startsWith("__reactProps$"));
  const props = key ? (textarea as unknown as Record<string, { onSelect?: (event: unknown) => void }>)[key] : undefined;
  if (!props?.onSelect) return;
  const noop = () => {};
  try {
    props.onSelect({
      type: "select",
      target: textarea,
      currentTarget: textarea,
      nativeEvent: {},
      persist: noop,
      preventDefault: noop,
      stopPropagation: noop,
      isDefaultPrevented: () => false,
      isPropagationStopped: () => false,
    });
  } catch {
    // Autocomplete then opens on the next keystroke Paseo sees instead.
  }
}

/** Mounts the editor over `textarea` and returns the function that takes it down. */
export function attachRichComposer(textarea: HTMLTextAreaElement): () => void {
  ensureStyle();
  // Read here, not at module load: the same bundle loads on iOS and Android.
  const PROTO_VALUE = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!;
  const PROTO_SET_SELECTION = HTMLTextAreaElement.prototype.setSelectionRange;
  const readValue = () => PROTO_VALUE.get!.call(textarea) as string;

  let segments: TextSegment[] = [];
  let lastText = "";
  let hostWritePending = false;
  let placeholder = "";
  let label = "";

  const host = document.createElement("div");

  const createState = (text: string, selection?: { start: number; end: number }) => {
    const doc = parseComposerText(text);
    const serialized = serializeComposer(doc);
    segments = serialized.segments;
    lastText = serialized.text;
    const state = EditorState.create({ doc, plugins: composerPlugins() });
    if (!selection) return state;
    const anchor = posForOffset(segments, selection.start);
    const head = posForOffset(segments, selection.end);
    return state.apply(state.tr.setSelection(TextSelection.create(doc, anchor, head)));
  };

  /** Writes the editor's selection to the textarea, as text offsets. */
  /** What Paseo's autocomplete was last told: the text and cursor it read. */
  let reported = "";
  const writeSelection = (state: EditorState) => {
    const start = offsetForPos(segments, state.selection.from);
    const end = offsetForPos(segments, state.selection.to);
    if (textarea.selectionStart !== start || textarea.selectionEnd !== end) PROTO_SET_SELECTION.call(textarea, start, end);
    // Writing the value already moved the textarea's caret to the end, so a
    // matching caret does not mean Paseo has heard about it.
    const next = `${start}:${end}:${lastText}`;
    if (next === reported) return;
    reported = next;
    reportSelection(textarea);
  };

  /** Writes the editor's text to the textarea the way typing would. */
  const writeText = (text: string) => {
    if (text === readValue()) return;
    PROTO_VALUE.set!.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  };

  const view = new EditorView({ mount: host }, {
    state: createState(readValue()),
    editable: () => !textarea.readOnly && !textarea.disabled,
    // ProseMirror owns the mounted element's attributes, class included.
    attributes: () => ({
      class: "bp-rc",
      role: "textbox",
      "aria-multiline": "true",
      "aria-label": label,
      "data-placeholder": placeholder,
      "data-bp-rich-composer": "",
    }),
    dispatchTransaction(tr: Transaction) {
      const state = view.state.apply(tr);
      view.updateState(state);
      if (tr.docChanged) {
        const serialized = serializeComposer(state.doc);
        segments = serialized.segments;
        lastText = serialized.text;
        writeText(lastText);
      }
      writeSelection(state);
    },
    handleKeyDown(editorView, event) {
      if (!offeredToHost(event, lastText, editorView.state.selection.empty)) return false;
      writeText(lastText);
      writeSelection(editorView.state);
      const offered = new KeyboardEvent("keydown", {
        key: event.key,
        code: event.code,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        repeat: event.repeat,
        bubbles: true,
        cancelable: true,
      });
      textarea.dispatchEvent(offered);
      if (!offered.defaultPrevented) return false;
      event.preventDefault();
      return true;
    },
    handlePaste(editorView, event) {
      const data = event.clipboardData;
      if (!data) return false;
      const images = Array.from(data.files).some((file) => file.type.startsWith("image/"));
      if (images) {
        // Paseo's own paste listener turns the images into attachments.
        textarea.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
        event.preventDefault();
        return true;
      }
      // Copied from this editor (or another ProseMirror one): its structure
      // parses with the composer's schema, so lists and code stay formatted.
      if (data.getData("text/html").includes("data-pm-slice")) return false;
      const text = data.getData("text/plain");
      if (!text) return false;
      event.preventDefault();
      const { state } = editorView;
      if (state.selection.$from.parent.type.spec.code) {
        editorView.dispatch(state.tr.insertText(text).scrollIntoView());
        return true;
      }
      const lines = literalDoc(text.replace(/\r\n?/g, "\n")).content;
      editorView.dispatch(state.tr.replaceSelection(new Slice(lines, 1, 1)).scrollIntoView());
      return true;
    },
    clipboardTextSerializer: (slice) => serializeFragment(slice.content),
    handleDOMEvents: {
      focus: () => {
        textarea.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
        return false;
      },
      blur: () => {
        textarea.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
        return false;
      },
    },
  });

  /** Reads a text Paseo wrote straight into the textarea back into the editor. */
  const readHostWrite = () => {
    hostWritePending = false;
    const text = readValue();
    const selection = { start: textarea.selectionStart, end: textarea.selectionEnd };
    if (text !== lastText) {
      view.updateState(createState(text, selection));
      return;
    }
    const anchor = posForOffset(segments, selection.start);
    const head = posForOffset(segments, selection.end);
    const current = view.state.selection;
    if (current.anchor === anchor && current.head === head) return;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, anchor, head)));
  };
  const scheduleHostWrite = () => {
    if (hostWritePending) return;
    hostWritePending = true;
    queueMicrotask(readHostWrite);
  };

  // React's value tracker is an own property; keep it working underneath.
  const ownValue = Object.getOwnPropertyDescriptor(textarea, "value");
  const baseValue = ownValue ?? PROTO_VALUE;
  Object.defineProperty(textarea, "value", {
    configurable: true,
    enumerable: baseValue.enumerable,
    get() {
      return baseValue.get!.call(textarea);
    },
    set(next: string) {
      baseValue.set!.call(textarea, next);
      scheduleHostWrite();
    },
  });
  const setSelectionRange: typeof textarea.setSelectionRange = (start, end, direction) => {
    PROTO_SET_SELECTION.call(textarea, start, end, direction);
    scheduleHostWrite();
  };
  textarea.setSelectionRange = setSelectionRange;
  textarea.focus = () => view.focus();
  textarea.blur = () => view.dom.blur();

  // Better Paseo's own Add to chat (`components/selection-actions.ts`) writes
  // the textarea the way it would a plain one, which this editor cannot see;
  // for a composer with an editor it asks here instead.
  const insertRequested = (event: Event) => {
    const { text, start, end } = (event as CustomEvent<RichComposerInsert>).detail;
    const from = posForOffset(segments, start);
    const to = posForOffset(segments, end);
    const content = parseComposerText(text).content;
    const tr = view.state.tr.replaceRange(from, to, new Slice(content, 1, 1));
    view.dispatch(tr.scrollIntoView());
    view.focus();
    event.preventDefault();
  };
  textarea.addEventListener(RICH_COMPOSER_INSERT, insertRequested);

  // The textarea's box, read once: hiding it below overrides its padding and size.
  const box = getComputedStyle(textarea);
  for (const name of ["padding-top", "padding-right", "padding-bottom", "padding-left"]) {
    host.style.setProperty(name, box.getPropertyValue(name));
  }
  host.style.setProperty("min-height", box.minHeight === "0px" ? `${textarea.offsetHeight || 0}px` : box.minHeight);
  host.style.setProperty("max-height", "max(160px, 50vh)");
  host.style.setProperty("width", "100%");
  // Paseo sizes every child of the composer's input wrapper to the height it
  // measured for the textarea (`.unistyles_... > * { height }`); the editor
  // takes the height of its own content instead.
  host.style.setProperty("height", "auto", "important");
  host.style.setProperty("flex", "0 0 auto", "important");

  /** Placeholder, colours and type, taken from the textarea it replaces. */
  const syncLook = () => {
    const computed = getComputedStyle(textarea);
    const placeholderColor = getComputedStyle(textarea, "::placeholder").color;
    placeholder = textarea.placeholder ?? "";
    label = textarea.getAttribute("aria-label") ?? placeholder;
    for (const name of ["font-size", "line-height", "font-weight", "letter-spacing", "color"]) {
      host.style.setProperty(name, computed.getPropertyValue(name));
    }
    host.style.setProperty("--bp-rc-placeholder", placeholderColor || computed.color);
    host.style.setProperty("--bp-rc-muted", placeholderColor || computed.color);
    view.setProps({});
  };
  syncLook();

  // Hidden, but on screen to code that looks for a visible composer. No
  // width: Paseo measures the textarea's text at its width to size the
  // composer, and skips the measurement when the width is 0 (a 1px width made
  // every character a line, and the composer grew with each keystroke).
  const hiddenStyle: [string, string][] = [
    ["position", "absolute"],
    ["opacity", "0"],
    ["pointer-events", "none"],
    ["width", "0"],
    ["height", "1px"],
    ["min-height", "0"],
    ["padding", "0"],
    ["border-width", "0"],
    ["overflow", "hidden"],
  ];
  const previousStyle = hiddenStyle.map(([name]) => [name, textarea.style.getPropertyValue(name), textarea.style.getPropertyPriority(name)] as const);
  for (const [name, value] of hiddenStyle) textarea.style.setProperty(name, value, "important");
  const previousTabIndex = textarea.getAttribute("tabindex");
  textarea.setAttribute("tabindex", "-1");
  textarea.setAttribute("aria-hidden", "true");
  textarea.insertAdjacentElement("afterend", host);

  const attributes = new MutationObserver(() => syncLook());
  attributes.observe(textarea, { attributes: true, attributeFilter: ["readonly", "disabled", "placeholder", "aria-label"] });

  if (document.activeElement === textarea) view.focus();

  return () => {
    textarea.removeEventListener(RICH_COMPOSER_INSERT, insertRequested);
    attributes.disconnect();
    view.destroy();
    host.remove();
    if (ownValue) Object.defineProperty(textarea, "value", ownValue);
    else delete (textarea as { value?: string }).value;
    delete (textarea as { setSelectionRange?: unknown }).setSelectionRange;
    delete (textarea as { focus?: unknown }).focus;
    delete (textarea as { blur?: unknown }).blur;
    for (const [name, value, priority] of previousStyle) {
      if (value) textarea.style.setProperty(name, value, priority);
      else textarea.style.removeProperty(name);
    }
    if (previousTabIndex == null) textarea.removeAttribute("tabindex");
    else textarea.setAttribute("tabindex", previousTabIndex);
    textarea.removeAttribute("aria-hidden");
  };
}
