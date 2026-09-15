import { describe, expect, it } from "vitest";
import { decide } from "../src/decisionGate.js";

describe("decide", () => {
  it("passes when score meets the threshold and no tests are failing", () => {
    expect(decide(75, 75, 0, 3, false)).toBe("pass");
    expect(decide(90, 75, 0, 3, false)).toBe("pass");
  });

  it("repairs when below threshold and budget remains", () => {
    expect(decide(50, 75, 0, 3, false)).toBe("repair");
    expect(decide(50, 75, 2, 3, false)).toBe("repair");
  });

  it("blocks when below threshold and budget is exhausted", () => {
    expect(decide(50, 75, 3, 3, false)).toBe("block");
    expect(decide(50, 75, 10, 3, false)).toBe("block");
  });

  it("never returns repair once iteration >= maxIterations (bounded)", () => {
    for (let iteration = 0; iteration <= 20; iteration += 1) {
      const result = decide(0, 75, iteration, 3, false);
      if (iteration >= 3) expect(result).toBe("block");
    }
  });

  it("never passes with a failing test, even at a perfect score", () => {
    expect(decide(100, 75, 0, 3, true)).toBe("repair");
    expect(decide(100, 75, 3, 3, true)).toBe("block");
  });

  it("regression: a high blended score must not mask a real failing test", () => {
    // 17/18 tests passing + clean lint + mutation skipped (weight
    // redistributed) blends to ~96/100 in the aggregator — empirically
    // observed in a real run — which must still not clear the gate.
    expect(decide(96.3, 75, 0, 3, true)).toBe("repair");
  });
});
