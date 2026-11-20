/**
 * The rich composer's document model, and its conversion to and from the
 * plain prompt text Paseo's composer holds.
 *
 * The composer stays a text field to Paseo: every edit is written back to its
 * textarea as Markdown text, and every text Paseo writes (clear after send,
 * recall, autocomplete, dictation, rewind) is read back into a document. Only
 * the syntax claude.ai's prompt input turns into formatting is recognised:
 * `-`, `*` and `+` bullets, `1.` numbered lists, nested lists, fenced code
 * blocks, inline code and strikethrough. Everything else stays literal text.
 *
 * One line of text is one paragraph, so a prompt with no formatting maps to
 * the same text character for character. `parseComposerText` keeps that
 * promise for every input: when its reading would not serialise back to the
 * exact text it was given, it returns the text as literal paragraphs instead.
 */
import { Schema, type Node as PMNode } from "../vendor/prosemirror";

export const composerSchema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      content: "inline*",
      group: "block",
      parseDOM: [{ tag: "p" }],
      toDOM: () => ["p", 0],
    },
    bullet_list: {
      content: "list_item+",
      group: "block",
      // `marker` is the bullet character typed; `indent` the column of the
      // markers when it differs from the one the nesting implies (null).
      attrs: { marker: { default: "-" }, indent: { default: null } },
      parseDOM: [{ tag: "ul" }],
      toDOM: () => ["ul", 0],
    },
    ordered_list: {
      content: "list_item+",
      group: "block",
      attrs: { start: { default: 1 }, indent: { default: null } },
      parseDOM: [{ tag: "ol", getAttrs: (dom) => ({ start: Number((dom as HTMLElement).getAttribute("start") ?? 1) || 1 }) }],
      toDOM: (node) => ["ol", node.attrs.start === 1 ? {} : { start: String(node.attrs.start) }, 0],
    },
    list_item: {
      // No code block inside a list: claude.ai's input has none either, and an
      // indented fence would not survive the text round trip.
      content: "paragraph (paragraph | bullet_list | ordered_list)*",
      defining: true,
      parseDOM: [{ tag: "li" }],
      toDOM: () => ["li", 0],
    },
    code_block: {
      content: "text*",
      group: "block",
      marks: "",
      code: true,
      defining: true,
      attrs: { info: { default: "" } },
      parseDOM: [{ tag: "pre", preserveWhitespace: "full" }],
      // `data-pmono` opts the block out of Paseo's forced UI font.
      toDOM: (node) => ["pre", { "data-pmono": "", "data-info": node.attrs.info || null }, ["code", { "data-pmono": "" }, 0]],
    },
    text: { group: "inline" },
  },
  marks: {
    strike: {
      inclusive: false,
      parseDOM: [{ tag: "s" }, { tag: "del" }],
      toDOM: () => ["s", 0],
    },
    code: {
      inclusive: false,
      excludes: "_",
      parseDOM: [{ tag: "code" }],
      toDOM: () => ["code", { "data-pmono": "" }, 0],
    },
  },
});

const NODES = composerSchema.nodes;
const MARKS = composerSchema.marks;

/** A run of characters that maps one to one between the document and the text. */
export interface TextSegment {
  /** Document position of the run's first character. */
  pos: number;
  /** Text offset of the run's first character. */
  offset: number;
  length: number;
}

export interface SerializedComposer {
  text: string;
  /** In document order; every textblock has at least one, possibly empty. */
  segments: TextSegment[];
}

const BULLET = /^( *)([-*+]) (.*)$/;
const ORDERED = /^( *)(\d{1,9})\. (.*)$/;
const FENCE_OPEN = /^(`{3,})([^`\s]*)$/;

// ---------------------------------------------------------------------------
// Serialising

/** The prompt text for a document, with where each of its characters came from. */
export function serializeComposer(doc: PMNode): SerializedComposer {
  const lines: string[] = [];
  const segments: TextSegment[] = [];
  let offset = 0;

  const pushLine = (line: string) => {
    if (lines.length > 0) offset += 1;
    lines.push(line);
    offset += line.length;
  };

  /** Writes a textblock's inline content after `prefix`, recording its segments. */
  const pushInline = (prefix: string, block: PMNode, blockPos: number) => {
    let line = prefix;
    const lineStart = lines.length > 0 ? offset + 1 : offset;
    let struck = false;
    block.forEach((child, childOffset) => {
      const text = child.text ?? "";
      // A code span excludes every other mark, so it never sits inside `~~`.
      const strike = MARKS.strike.isInSet(child.marks) != null;
      if (strike !== struck) {
        line += "~~";
        struck = strike;
      }
      const span = MARKS.code.isInSet(child.marks) ? codeSpanDelimiters(text) : ["", ""];
      line += span[0];
      segments.push({ pos: blockPos + 1 + childOffset, offset: lineStart + line.length, length: text.length });
      line += text + span[1];
    });
    if (struck) line += "~~";
    if (block.childCount === 0) segments.push({ pos: blockPos + 1, offset: lineStart + line.length, length: 0 });
    pushLine(line);
  };

  const writeList = (list: PMNode, listPos: number, column: number) => {
    const indent = typeof list.attrs.indent === "number" ? list.attrs.indent : column;
    list.forEach((item, itemOffset, index) => {
      const marker = list.type === NODES.ordered_list ? `${list.attrs.start + index}.` : list.attrs.marker;
      const itemPos = listPos + 1 + itemOffset;
      const contentColumn = indent + marker.length + 1;
      item.forEach((child, childOffset, childIndex) => {
        const childPos = itemPos + 1 + childOffset;
        if (child.type === NODES.paragraph) {
          const prefix = childIndex === 0 ? `${" ".repeat(indent)}${marker} ` : " ".repeat(contentColumn);
          pushInline(prefix, child, childPos);
        } else {
          writeList(child, childPos, contentColumn);
        }
      });
    });
  };

  doc.forEach((block, blockOffset) => {
    if (block.type === NODES.paragraph) pushInline("", block, blockOffset);
    else if (block.type === NODES.code_block) {
      const fence = codeFence(block.textContent);
      pushLine(`${fence}${block.attrs.info}`);
      const contentStart = offset + 1;
      segments.push({ pos: blockOffset + 1, offset: contentStart, length: block.textContent.length });
      block.textContent.split("\n").forEach((line) => pushLine(line));
      pushLine(fence);
    } else writeList(block, blockOffset, 0);
  });

  return { text: lines.join("\n"), segments };
}

/** A fence longer than any backtick run inside the code. */
function codeFence(code: string): string {
  const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
  return "`".repeat(Math.max(3, longest + 1));
}

/** Backticks around a code span: one more than its longest run, padded when it starts or ends with one. */
function codeSpanDelimiters(code: string): [string, string] {
  const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
  const ticks = "`".repeat(longest + 1);
  const pad = code.startsWith("`") || code.endsWith("`") ? " " : "";
  return [ticks + pad, pad + ticks];
}

// ---------------------------------------------------------------------------
// Parsing

/** The document for a prompt text: formatted where it can be, literal otherwise. */
export function parseComposerText(text: string): PMNode {
  const formatted = parseFormatted(text);
  if (formatted && serializeComposer(formatted).text === text) return formatted;
  return literalDoc(text);
}

/** Every line a plain paragraph, nothing recognised. */
export function literalDoc(text: string): PMNode {
  return NODES.doc.create(null, text.split("\n").map((line) => NODES.paragraph.create(null, line ? composerSchema.text(line) : null)));
}

interface ListLine {
  indent: number;
  ordered: boolean;
  marker: string;
  number: number;
  content: string;
}

function listLine(line: string): ListLine | null {
  const bullet = BULLET.exec(line);
  if (bullet) return { indent: bullet[1]!.length, ordered: false, marker: bullet[2]!, number: 0, content: bullet[3]! };
  const ordered = ORDERED.exec(line);
  if (ordered) return { indent: ordered[1]!.length, ordered: true, marker: ".", number: Number(ordered[2]), content: ordered[3]! };
  return null;
}

function parseFormatted(text: string): PMNode | null {
  const lines = text.split("\n");
  const blocks: PMNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    const fence = FENCE_OPEN.exec(line);
    if (fence) {
      const close = lines.findIndex((candidate, at) => at > index && candidate === fence[1]);
      if (close > index) {
        const code = lines.slice(index + 1, close).join("\n");
        blocks.push(NODES.code_block.create({ info: fence[2]! }, code ? composerSchema.text(code) : null));
        index = close + 1;
        continue;
      }
    }
    const item = listLine(line);
    if (item && item.indent === 0) {
      const parsed = parseList(lines, index, 0);
      blocks.push(parsed.node);
      index = parsed.next;
      continue;
    }
    blocks.push(NODES.paragraph.create(null, parseInline(line)));
    index += 1;
  }
  return blocks.length > 0 ? NODES.doc.create(null, blocks) : null;
}

/** A list starting at `lines[start]`, whose markers sit at `column`, implied by its parent. */
function parseList(lines: string[], start: number, column: number): { node: PMNode; next: number } {
  const first = listLine(lines[start]!) as ListLine;
  const items: PMNode[] = [];
  let index = start;
  while (index < lines.length) {
    const head = listLine(lines[index]!);
    if (!head || head.indent !== first.indent || head.ordered !== first.ordered || head.marker !== first.marker) break;
    const contentColumn = head.indent + (head.ordered ? String(head.number).length + 1 : 1) + 1;
    const children: PMNode[] = [NODES.paragraph.create(null, parseInline(head.content))];
    index += 1;
    while (index < lines.length) {
      const line = lines[index]!;
      const nested = listLine(line);
      if (nested && nested.indent >= contentColumn) {
        const parsed = parseList(lines, index, contentColumn);
        children.push(parsed.node);
        index = parsed.next;
        continue;
      }
      // A continuation line: indented to the item's content, not a list line.
      if (!nested && line.length > contentColumn && line.startsWith(" ".repeat(contentColumn)) && line[contentColumn] !== " ") {
        children.push(NODES.paragraph.create(null, parseInline(line.slice(contentColumn))));
        index += 1;
        continue;
      }
      break;
    }
    items.push(NODES.list_item.create(null, children));
  }
  const indent = first.indent === column ? null : first.indent;
  const node = first.ordered
    ? NODES.ordered_list.create({ start: first.number, indent }, items)
    : NODES.bullet_list.create({ marker: first.marker, indent }, items);
  return { node, next: index };
}

/** Inline code and strikethrough in one line; the rest is text. */
export function parseInline(line: string): PMNode[] {
  const nodes: PMNode[] = [];
  const pattern = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|~~([^~]+)~~/g;
  let last = 0;
  for (let match = pattern.exec(line); match; match = pattern.exec(line)) {
    if (match.index > last) nodes.push(composerSchema.text(line.slice(last, match.index)));
    if (match[1]) nodes.push(composerSchema.text(match[2]!, [MARKS.code.create()]));
    else nodes.push(...parseInline(match[3]!).map((node) => node.mark(MARKS.strike.create().addToSet(node.marks))));
    last = match.index + match[0].length;
  }
  if (last < line.length) nodes.push(composerSchema.text(line.slice(last)));
  return nodes;
}

// ---------------------------------------------------------------------------
// Positions

/** The text offset for a document position, snapped into the nearest run. */
export function offsetForPos(segments: TextSegment[], pos: number): number {
  let best = segments[0] ?? { pos: 0, offset: 0, length: 0 };
  for (const segment of segments) {
    if (pos >= segment.pos && pos <= segment.pos + segment.length) return segment.offset + (pos - segment.pos);
    if (segment.pos <= pos) best = segment;
  }
  return pos < best.pos ? best.offset : best.offset + best.length;
}

/** The document position for a text offset, snapped into the nearest run. */
export function posForOffset(segments: TextSegment[], offset: number): number {
  let best = segments[0] ?? { pos: 1, offset: 0, length: 0 };
  for (const segment of segments) {
    if (offset >= segment.offset && offset <= segment.offset + segment.length) return segment.pos + (offset - segment.offset);
    if (segment.offset <= offset) best = segment;
  }
  return offset < best.offset ? best.pos : best.pos + best.length;
}
