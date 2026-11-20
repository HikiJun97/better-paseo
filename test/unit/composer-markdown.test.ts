import { describe, expect, it } from "vitest";
import {
  composerSchema,
  offsetForPos,
  parseComposerText,
  posForOffset,
  serializeComposer,
} from "../../client/composer/markdown";

const { nodes, marks } = composerSchema;
const text = (value: string, ...applied: ("code" | "strike")[]) =>
  composerSchema.text(value, applied.map((name) => marks[name].create()));
const p = (...content: ReturnType<typeof text>[]) => nodes.paragraph.create(null, content);
const li = (...content: Parameters<typeof nodes.list_item.create>[1][]) => nodes.list_item.create(null, content.flat() as never);
const doc = (...blocks: Parameters<typeof nodes.doc.create>[1][]) => nodes.doc.create(null, blocks.flat() as never);

/** The structure of a parsed text, as plain data, for readable failures. */
const shape = (value: string) => parseComposerText(value).toJSON();

describe("parseComposerText", () => {
  it("reads -, * and + bullets, keeping the marker typed", () => {
    expect(shape("- a\n* b")).toEqual(doc(
      nodes.bullet_list.create({ marker: "-" }, [li(p(text("a")))]),
      nodes.bullet_list.create({ marker: "*" }, [li(p(text("b")))]),
    ).toJSON());
  });

  it("reads a numbered list from its first number", () => {
    expect(shape("3. a\n4. b")).toEqual(doc(
      nodes.ordered_list.create({ start: 3 }, [li(p(text("a"))), li(p(text("b")))]),
    ).toJSON());
  });

  it("nests a list indented to its parent's content", () => {
    expect(shape("- a\n  - b\n1. c\n   1. d")).toEqual(doc(
      nodes.bullet_list.create(null, [li(p(text("a")), nodes.bullet_list.create(null, [li(p(text("b")))]))]),
      nodes.ordered_list.create(null, [li(p(text("c")), nodes.ordered_list.create(null, [li(p(text("d")))]))]),
    ).toJSON());
  });

  it("reads a closed fence as a code block with its info string", () => {
    expect(shape("see\n```ts\nconst a = 1;\n\nreturn a;\n```")).toEqual(doc(
      p(text("see")),
      nodes.code_block.create({ info: "ts" }, text("const a = 1;\n\nreturn a;")),
    ).toJSON());
  });

  it("leaves an unclosed fence as text", () => {
    expect(shape("```ts\nconst a = 1;")).toEqual(doc(p(text("```ts")), p(text("const a = 1;"))).toJSON());
  });

  it("reads inline code and strikethrough, and nothing else inline", () => {
    expect(shape("run `npm test` not ~~yarn~~ **now**")).toEqual(doc(p(
      text("run "), text("npm test", "code"), text(" not "), text("yarn", "strike"), text(" **now**"),
    )).toJSON());
  });

  it("falls back to literal lines when its reading would change the text", () => {
    // Renumbering 1. 1. to 1. 2. would rewrite what the user typed.
    expect(shape("1. a\n1. b")).toEqual(doc(p(text("1. a")), p(text("1. b"))).toJSON());
  });

  it("keeps a dash with no space, a heading and a quote as text", () => {
    expect(shape("-a\n# title\n> quote")).toEqual(doc(p(text("-a")), p(text("# title")), p(text("> quote"))).toJSON());
  });
});

describe("serializeComposer", () => {
  it("writes lists, nesting and empty lines back as Markdown", () => {
    const value = doc(
      p(text("intro")),
      p(),
      nodes.bullet_list.create({ marker: "*" }, [li(p(text("a")), nodes.ordered_list.create({ start: 2 }, [li(p(text("b"))), li(p(text("c")))]))]),
    );
    expect(serializeComposer(value).text).toBe("intro\n\n* a\n  2. b\n  3. c");
  });

  it("writes an empty list item as its marker and a space", () => {
    expect(serializeComposer(doc(nodes.bullet_list.create(null, [li(p())]))).text).toBe("- ");
  });

  it("fences code with more backticks than it contains", () => {
    const value = doc(nodes.code_block.create({ info: "md" }, text("```\nx\n```")));
    expect(serializeComposer(value).text).toBe("````md\n```\nx\n```\n````");
  });

  it("widens a code span around backticks it contains", () => {
    expect(serializeComposer(doc(p(text("a`b", "code")))).text).toBe("``a`b``");
    expect(serializeComposer(doc(p(text("`a", "code")))).text).toBe("`` `a ``");
  });

  it("closes strikethrough before a later unmarked run", () => {
    expect(serializeComposer(doc(p(text("x", "strike"), text("y")))).text).toBe("~~x~~y");
  });
});

describe("round trip", () => {
  it.each([
    "",
    "plain\n\ntwo lines",
    "- a\n- b\n\n1. one\n2. two",
    "+ a\n  + b\n    + c\n+ d",
    "10. ten\n11. eleven\n    - child",
    "- item\n  continued",
    "```\n\n```",
    "```py\ndef f():\n    return 1\n```\nafter",
    "a `b` ~~c~~ d",
    "- `code` in a ~~list~~",
    "    indented text\n\ttab",
  ])("gives back %j unchanged", (value) => {
    expect(serializeComposer(parseComposerText(value)).text).toBe(value);
  });
});

describe("positions", () => {
  // "- ab\n`cd`": "a" is text offset 2, "c" is offset 6.
  const value = "- ab\n`cd`";
  const parsed = parseComposerText(value);
  const { segments } = serializeComposer(parsed);
  const posOf = (character: string) => {
    let found = -1;
    parsed.descendants((node, pos) => {
      if (found < 0 && node.isText && node.text!.includes(character)) found = pos + node.text!.indexOf(character);
    });
    return found;
  };

  it("maps a document position to the character's text offset", () => {
    expect(offsetForPos(segments, posOf("a"))).toBe(2);
    expect(offsetForPos(segments, posOf("c"))).toBe(6);
  });

  it("maps a text offset back to the same character", () => {
    expect(posForOffset(segments, 2)).toBe(posOf("a"));
    expect(posForOffset(segments, 6)).toBe(posOf("c"));
  });

  it("snaps an offset inside a marker to the start of the item's text", () => {
    expect(posForOffset(segments, 0)).toBe(posOf("a"));
    expect(posForOffset(segments, 1)).toBe(posOf("a"));
  });
});
