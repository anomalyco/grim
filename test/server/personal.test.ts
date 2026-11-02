// An account's own workspace (personal.ts): its title from any name, and one whose making was cut off is finished.
import { describe, expect, test } from "bun:test";
import { personalTitle } from "../../src/server/personal.ts";

describe("personalTitle", () => {
  test("the first name, in any script; My notes without one", () => {
    expect(personalTitle("Ada Lovelace")).toBe("Ada's notes");
    expect(personalTitle("  सुनील  कुमार ")).toBe("सुनील's notes");
    expect(personalTitle("王小明")).toBe("王小明's notes");
    expect(personalTitle("Ünal")).toBe("Ünal's notes");
    expect(personalTitle("")).toBe("My notes");
    expect(personalTitle(null)).toBe("My notes");
    expect(personalTitle("   ")).toBe("My notes");
    expect(personalTitle("🙂 Smile")).toBe("My notes");
    expect(personalTitle("x".repeat(60))).toBe(`${"x".repeat(40)}'s notes`);
  });
});
