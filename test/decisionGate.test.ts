import { describe, expect, it } from "vitest";
import { decide } from "../src/decisionGate.js";

describe("decide", () => {
  it("passes when score meets the threshold", () => {
    expect(decide(75, 75, 0, 3)).toBe("pass");
    expect(decide(90, 75, 0, 3)).toBe("pass");
  });

  it("repairs when below threshold and budget remains", () => {
    expect(decide(50, 75, 0, 3)).toBe("repair");
    expect(decide(50, 75, 2, 3)).toBe("repair");
  });

  it("blocks when below threshold and budget is exhausted", () => {
    expect(decide(50, 75, 3, 3)).toBe("block");
    expect(decide(50, 75, 10, 3)).toBe("block");
  });

  it("never returns repair once iteration >= maxIterations (bounded)", () => {
    for (let iteration = 0; iteration <= 20; iteration += 1) {
      const result = decide(0, 75, iteration, 3);
      if (iteration >= 3) expect(result).toBe("block");
    }
  });
});
