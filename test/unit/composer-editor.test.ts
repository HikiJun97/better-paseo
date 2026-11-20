import { describe, expect, it } from "vitest";
import { EditorState, TextSelection, type Transaction } from "../../client/vendor/prosemirror";
import { clearCodeBlock, listBackspace } from "../../client/composer/editor";
import { parseComposerText, serializeComposer } from "../../client/composer/markdown";

/** A state for `text` with the cursor at text offset `cursor`. */
function stateAt(text: string, cursor: number): EditorState {
  const doc = parseComposerText(text);
  const { segments } = serializeComposer(doc);
  const segment = segments.find((candidate) => cursor >= candidate.offset && cursor <= candidate.offset + candidate.length)!;
  const pos = segment.pos + (cursor - segment.offset);
  return EditorState.create({ doc, selection: TextSelection.create(doc, pos) });
}

/** Runs Backspace; returns the text after it and the cursor's text offset, or null when it did nothing. */
function backspace(text: string, cursor: number, command = listBackspace): { text: string; cursor: number } | null {
  let next: Transaction | null = null;
  const handled = command(stateAt(text, cursor), (tr) => { next = tr; });
  if (!handled || !next) return null;
  const doc = (next as Transaction).doc;
  const serialized = serializeComposer(doc);
  const pos = (next as Transaction).selection.from;
  const segment = serialized.segments.find((candidate) => pos >= candidate.pos && pos <= candidate.pos + candidate.length)!;
  return { text: serialized.text, cursor: segment.offset + (pos - segment.pos) };
}

describe("Backspace at the start of a list item", () => {
  it("removes an emptied numbered item and puts the cursor at the end of the line above", () => {
    // "1. first\n2. " with the cursor after "2. "
    expect(backspace("1. first\n2. ", 12)).toEqual({ text: "1. first", cursor: 8 });
  });

  it("removes an emptied item in the middle and renumbers the rest", () => {
    expect(backspace("1. a\n2. \n3. c", 8)).toEqual({ text: "1. a\n2. c", cursor: 4 });
  });

  it("joins a non-empty item's text onto the end of the item above", () => {
    expect(backspace("- one\n- two", 8)).toEqual({ text: "- onetwo", cursor: 5 });
  });

  it("removes an emptied nested item and returns to its parent's line", () => {
    expect(backspace("- a\n  - ", 8)).toEqual({ text: "- a", cursor: 3 });
  });

  it("removes an emptied first item into the paragraph above the list", () => {
    expect(backspace("intro\n1. ", 9)).toEqual({ text: "intro", cursor: 5 });
  });

  it("takes a non-empty first item out of its list, keeping its text", () => {
    expect(backspace("intro\n1. one", 9)).toEqual({ text: "intro\none", cursor: 6 });
  });

  it("leaves Backspace inside an item's text to the default", () => {
    expect(backspace("1. one", 4)).toBeNull();
  });
});

describe("Backspace in an empty code block", () => {
  it("turns it back into a line and drops the empty line the block opened below it", () => {
    // "```\n\n```\n" is an empty code block followed by an empty line; the cursor is inside the block.
    expect(backspace("```\n\n```\n", 4, clearCodeBlock)).toEqual({ text: "", cursor: 0 });
  });

  it("keeps a following line that has text", () => {
    expect(backspace("```\n\n```\nafter", 4, clearCodeBlock)).toEqual({ text: "\nafter", cursor: 0 });
  });

  it("does nothing in a code block that still has code", () => {
    expect(backspace("```\nx\n```", 4, clearCodeBlock)).toBeNull();
  });
});
