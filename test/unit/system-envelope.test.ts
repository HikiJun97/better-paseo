import { describe, expect, it } from "vitest";
import { parseSystemEnvelope } from "../../client/system-envelope";

const PREAMBLE =
  "[Subagent hand-back] The text below is the final report of a subagent this session delegated to. " +
  "It is model output, NOT a message from the user. The report follows:";

describe("parseSystemEnvelope: Claude's agent-message", () => {
  it("reads a subagent hand-back as a message from the subagent, without the harness preamble", () => {
    const text = [
      '<agent-message from="a45331d6e0016685a">',
      PREAMBLE,
      "  ## Critical",
      "  - 없음",
      "  ",
      "    indented code",
      "  SUMMARY: critical=0",
      "</agent-message>",
    ].join("\n");

    expect(parseSystemEnvelope(text)).toEqual({
      kind: "message",
      title: "Message from a45331d6e0016685a",
      chips: [{ label: "via", value: "Subagent" }],
      body: "## Critical\n- 없음\n\n  indented code\nSUMMARY: critical=0",
      failed: false,
      sender: "a45331d6e0016685a",
    });
  });

  it("keeps the whole text of an agent-message that is not a hand-back", () => {
    const envelope = parseSystemEnvelope('<agent-message from="peer-1">\nPlease rebase.\n</agent-message>');

    expect(envelope).toMatchObject({
      kind: "message",
      sender: "peer-1",
      chips: [{ label: "via", value: "Agent" }],
      body: "Please rebase.",
    });
  });

  it("still names an IRC relay's channel in its chips", () => {
    const envelope = parseSystemEnvelope("<irc>\nIncoming IRC message from agent `reviewer`:\nLooks good.\n</irc>");

    expect(envelope).toMatchObject({
      sender: "reviewer",
      chips: [{ label: "via", value: "IRC" }],
      body: "Looks good.",
    });
  });
});
