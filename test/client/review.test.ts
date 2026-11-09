// Review mode (src/client/review.ts): the latest author's batch of changes from the history, and its highlights.
import { expect, test } from "bun:test";
import { latestBatch, reviewChanged, reviewLabel, sameAuthor } from "../../src/client/review.ts";

const c = (sha: string, authorName: string, authorEmail = `${authorName.toLowerCase()}@x.com`) => ({ sha, authorName, authorEmail });

test("the latest author's commits back to somebody else's: that commit is the baseline", () => {
  const commits = [c("c4", "Alice"), c("c3", "Alice"), c("c2", "Bob"), c("c1", "Alice")];
  expect(latestBatch(commits, null)).toEqual({ author: { name: "Alice", email: "alice@x.com" }, baseline: "c2" });
  // someone else's live edits are the newest batch: the newest commit is the baseline
  expect(latestBatch(commits, { name: "Bob" })).toEqual({ author: { name: "Bob" }, baseline: "c4" });
  // the same author's live edits go on with their commits (names compared without " (guest)")
  expect(latestBatch(commits, { name: "alice" }).baseline).toBe("c2");
  expect(latestBatch([c("c2", "moist-noodle (guest)"), c("c1", "Ann")], { name: "moist-noodle" }).baseline).toBe("c1");
  // one author all along: the empty note; a full page of them: its oldest commit
  expect(latestBatch([c("c2", "Alice"), c("c1", "Alice")], null).baseline).toBeNull();
  expect(latestBatch([c("c2", "Alice"), c("c1", "Alice")], null, 2).baseline).toBe("c1");
  // an agent's commits count as the agent
  expect(latestBatch([c("c3", "OpenCode", "opencode@agents.grimoire"), c("c2", "OpenCode", "opencode@agents.grimoire"), c("c1", "Alice")], null).baseline).toBe("c1");
  // nothing at all
  expect(latestBatch([], null)).toEqual({ author: null, baseline: null });
});

test("same author: the email when both have one, else the name", () => {
  expect(sameAuthor({ name: "A", email: "a@x" }, { name: "B", email: "A@X" })).toBe(true);
  expect(sameAuthor({ name: "A", email: "a@x" }, { name: "A", email: "b@x" })).toBe(false);
  expect(sameAuthor({ name: "Ann" }, { name: "ann", email: "a@x" })).toBe(true);
});

test("highlighted lines: added or changed, not blank", () => {
  expect(reviewChanged("one\ntwo\nthree", "one\nTWO\nthree\n\nfour")).toEqual([false, true, false, false, true]);
  expect(reviewChanged("", "a\nb")).toEqual([true, true]);
  expect(reviewChanged("same", "same")).toEqual([false]);
});

test("the pill", () => {
  expect(reviewLabel(null, 3)).toBe("Review");
  expect(reviewLabel("Alice", 12)).toBe("Reviewing: Alice · 12 lines");
  expect(reviewLabel("Alice", 1)).toBe("Reviewing: Alice · 1 line");
});
