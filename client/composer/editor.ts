/**
 * The rich composer's editing behaviour: the Markdown shortcuts claude.ai's
 * prompt input recognises as you type, and the keys that work on lists and
 * code blocks. Keys Paseo's composer handles itself (send, recall,
 * autocomplete) never reach these: the bridge offers them to Paseo first
 * (`bridge.ts`), and only a key Paseo leaves alone falls through to here.
 */
import {
  InputRule,
  Plugin,
  TextSelection,
  baseKeymap,
  chainCommands,
  history,
  inputRules,
  keymap,
  liftListItem,
  newlineInCode,
  redo,
  setBlockType,
  sinkListItem,
  splitBlock,
  splitListItem,
  undo,
  undoInputRule,
  wrappingInputRule,
  type Command,
  type EditorState,
  type Node as PMNode,
} from "../vendor/prosemirror";
import { composerSchema } from "./markdown";

const { nodes, marks } = composerSchema;

/** A fence typed at the start of a paragraph: ``` or ```lang. */
const FENCE = /^```([^`\s]*)$/;

/**
 * Turns the paragraph around [start, end) into a code block, and gives it a
 * paragraph to continue in when nothing follows (claude.ai does the same).
 */
function toCodeBlock(state: EditorState, start: number, end: number, info: string) {
  const $start = state.doc.resolve(start);
  const parent = $start.node(-1);
  if (!parent.canReplaceWith($start.index(-1), $start.indexAfter(-1), nodes.code_block)) return null;
  const tr = state.tr.delete(start, end).setBlockType(start, start, nodes.code_block, { info });
  const $code = tr.doc.resolve(tr.mapping.map(start));
  const after = $code.after();
  if ($code.depth === 1 && after === tr.doc.content.size) tr.insert(after, nodes.paragraph.create());
  return tr.setSelection(TextSelection.create(tr.doc, $code.start()));
}

/** Wraps a typed `x` or ~~x~~ in its mark, dropping the delimiters. */
function markRule(pattern: RegExp, mark: "code" | "strike") {
  return new InputRule(pattern, (state, match, start, end) => {
    const inner = match[2]!;
    const from = start + match[1]!.length;
    const $from = state.doc.resolve(from);
    if ($from.parent.type.spec.code) return null;
    const tr = state.tr.replaceWith(from, end, composerSchema.text(inner, [marks[mark].create()]));
    return tr.removeStoredMark(marks[mark]);
  });
}

const rules = inputRules({
  rules: [
    wrappingInputRule(/^\s*([-+*])\s$/, nodes.bullet_list, (match) => ({ marker: match[1] }),
      (match, node) => node.attrs.marker === match[1]),
    wrappingInputRule(/^(\d{1,9})\.\s$/, nodes.ordered_list, (match) => ({ start: Number(match[1]) }),
      (match, node) => node.childCount + node.attrs.start === Number(match[1])),
    new InputRule(/^```([^`\s]*)\s$/, (state, match, start, end) => toCodeBlock(state, start, end, match[1]!)),
    markRule(/(^|[^`])`([^`]+)`$/, "code"),
    markRule(/(^|[^~])~~([^~]+)~~$/, "strike"),
  ],
});

/** Shift+Enter on a paragraph that holds only a fence opens a code block. */
const fenceToCodeBlock: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parent.type !== nodes.paragraph) return false;
  const fence = FENCE.exec($from.parent.textContent);
  if (!fence || $from.parentOffset !== $from.parent.content.size) return false;
  const tr = toCodeBlock(state, $from.start(), $from.end(), fence[1]!);
  if (!tr) return false;
  dispatch?.(tr.scrollIntoView());
  return true;
};

/** Backspace at the start of an empty code block turns it back into a paragraph. */
const clearCodeBlock: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parent.type !== nodes.code_block || $from.parent.content.size > 0) return false;
  return setBlockType(nodes.paragraph)(state, dispatch);
};

/** Backspace at the start of a list item's first line lifts it out of the list. */
const liftAtItemStart: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parentOffset > 0 || $from.depth < 2 || $from.node(-1).type !== nodes.list_item) return false;
  if ($from.index(-1) > 0) return false;
  return liftListItem(nodes.list_item)(state, dispatch);
};

/** ArrowDown at the end of a trailing code block opens a paragraph below it. */
const exitTrailingCode: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parent.type !== nodes.code_block || $from.parentOffset < $from.parent.content.size) return false;
  if ($from.depth !== 1 || $from.after() !== state.doc.content.size) return false;
  if (dispatch) {
    const tr = state.tr.insert($from.after(), nodes.paragraph.create());
    dispatch(tr.setSelection(TextSelection.create(tr.doc, $from.after() + 1)).scrollIntoView());
  }
  return true;
};

const newLine = chainCommands(
  fenceToCodeBlock,
  newlineInCode,
  splitListItem(nodes.list_item),
  liftListItem(nodes.list_item),
  splitBlock,
);

const keys = keymap({
  "Shift-Enter": newLine,
  Enter: newLine,
  Tab: sinkListItem(nodes.list_item),
  // No Shift-Tab: Paseo's mode-cycle shortcut takes it on the window before
  // the editor sees it. An item comes out with Backspace at its start, or
  // Shift+Enter on an empty one.
  Backspace: chainCommands(undoInputRule, clearCodeBlock, liftAtItemStart),
  ArrowDown: exitTrailingCode,
  ArrowRight: exitTrailingCode,
  "Mod-z": undo,
  "Shift-Mod-z": redo,
  "Mod-y": redo,
});

/** Marks the editor empty so its placeholder shows. */
const placeholder = new Plugin({
  props: {
    attributes: (state): Record<string, string> => (isEmptyDoc(state.doc) ? { class: "bp-rc-empty" } : {}),
  },
});

export function isEmptyDoc(doc: PMNode): boolean {
  return doc.childCount === 1 && doc.firstChild!.type === nodes.paragraph && doc.firstChild!.content.size === 0;
}

/** The editor plugins, in priority order. */
export function composerPlugins(): Plugin[] {
  return [rules, keys, keymap(baseKeymap), history(), placeholder];
}
