import { describe, expect, it } from "vitest";
import { $createLinkNode, LinkNode } from "@lexical/link";
import { createEditor } from "lexical";
import {
  MentionAwareLinkNode,
  getMentionAwareLinkNodeInit,
  mentionAwareLinkNodeReplacement,
} from "./mention-aware-link-node";

function createTestEditor() {
  return createEditor({
    namespace: "mention-aware-link-node-test",
    nodes: [MentionAwareLinkNode, mentionAwareLinkNodeReplacement],
    onError(error: Error) {
      throw error;
    },
  });
}

describe("getMentionAwareLinkNodeInit", () => {
  it("copies link attributes without carrying over a node key", () => {
    const init = getMentionAwareLinkNodeInit({
      getURL: () => "agent://agent-123",
      getRel: () => "noreferrer",
      getTarget: () => "_blank",
      getTitle: () => "Agent mention",
    });

    expect(Object.keys(init)).toEqual(["url", "attributes"]);
    expect(init).toEqual({
      url: "agent://agent-123",
      attributes: {
        rel: "noreferrer",
        target: "_blank",
        title: "Agent mention",
      },
    });
  });

  it("replaces LinkNode creation with MentionAwareLinkNode without throwing", () => {
    const editor = createTestEditor();
    let created: unknown;

    editor.update(() => {
      created = $createLinkNode("agent://agent-123");
    });

    expect(created).toBeInstanceOf(MentionAwareLinkNode);
  });
});

describe("MentionAwareLinkNode.sanitizeUrl", () => {
  function sanitizeInEditor(url: string): { mention: string; plain: string } {
    const editor = createTestEditor();
    let result = { mention: "", plain: "" };

    editor.update(
      () => {
        result = {
          mention: new MentionAwareLinkNode().sanitizeUrl(url),
          plain: new LinkNode().sanitizeUrl(url),
        };
      },
      { discrete: true },
    );

    return result;
  }

  it.each([
    "agent://agent-123",
    "project://project-123",
    "skill://skill-123",
    "routine://routine-123",
    "policy://never-ship-on-friday",
  ])("keeps the %s mention url instead of replacing it with about:blank", (url) => {
    expect(sanitizeInEditor(url).mention).toBe(url);
  });

  it("is only needed because the stock link node blanks routine and policy urls", () => {
    expect(sanitizeInEditor("routine://routine-123").plain).toBe("about:blank");
    expect(sanitizeInEditor("policy://never-ship-on-friday").plain).toBe("about:blank");
  });

  it("still blanks unsafe schemes", () => {
    expect(sanitizeInEditor("javascript:alert(1)").mention).toBe("about:blank");
    expect(sanitizeInEditor("policy-x://key").mention).toBe("about:blank");
  });
});
