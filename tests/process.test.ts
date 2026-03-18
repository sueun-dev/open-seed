import { describe, it, expect } from "vitest";
import {
  selectProcess,
  buildExecutionBatches,
  validateProcessPlan,
  type ProcessTask
} from "../src/orchestration/process.js";

describe("Process Abstraction", () => {
  describe("selectProcess", () => {
    it("returns sequential for single task", () => {
      expect(selectProcess([{ id: "t1", roleId: "executor", title: "Do thing" }])).toBe("sequential");
    });

    it("returns parallel for independent tasks", () => {
      const tasks: ProcessTask[] = [
        { id: "t1", roleId: "researcher", title: "Research A" },
        { id: "t2", roleId: "researcher", title: "Research B" },
        { id: "t3", roleId: "researcher", title: "Research C" }
      ];
      expect(selectProcess(tasks)).toBe("parallel");
    });

    it("returns sequential for chain dependencies", () => {
      const tasks: ProcessTask[] = [
        { id: "t1", roleId: "planner", title: "Plan" },
        { id: "t2", roleId: "executor", title: "Execute", dependsOn: ["t1"] },
        { id: "t3", roleId: "reviewer", title: "Review", dependsOn: ["t2"] }
      ];
      expect(selectProcess(tasks)).toBe("sequential");
    });

    it("returns hierarchical for complex dependencies", () => {
      const tasks: ProcessTask[] = [
        { id: "t1", roleId: "planner", title: "Plan" },
        { id: "t2", roleId: "executor", title: "Execute A", dependsOn: ["t1"] },
        { id: "t3", roleId: "executor", title: "Execute B", dependsOn: ["t1"] },
        { id: "t4", roleId: "reviewer", title: "Review", dependsOn: ["t2", "t3"] }
      ];
      expect(selectProcess(tasks)).toBe("hierarchical");
    });
  });

  describe("buildExecutionBatches", () => {
    it("groups independent tasks into one batch", () => {
      const tasks: ProcessTask[] = [
        { id: "t1", roleId: "a", title: "A" },
        { id: "t2", roleId: "b", title: "B" }
      ];
      const batches = buildExecutionBatches(tasks);
      expect(batches).toHaveLength(1);
      expect(batches[0]).toHaveLength(2);
    });

    it("separates dependent tasks into sequential batches", () => {
      const tasks: ProcessTask[] = [
        { id: "t1", roleId: "a", title: "A" },
        { id: "t2", roleId: "b", title: "B", dependsOn: ["t1"] },
        { id: "t3", roleId: "c", title: "C", dependsOn: ["t2"] }
      ];
      const batches = buildExecutionBatches(tasks);
      expect(batches).toHaveLength(3);
      expect(batches[0]).toHaveLength(1);
      expect(batches[0][0].id).toBe("t1");
    });

    it("parallelizes tasks with same dependency", () => {
      const tasks: ProcessTask[] = [
        { id: "t1", roleId: "a", title: "Root" },
        { id: "t2", roleId: "b", title: "Branch A", dependsOn: ["t1"] },
        { id: "t3", roleId: "c", title: "Branch B", dependsOn: ["t1"] }
      ];
      const batches = buildExecutionBatches(tasks);
      expect(batches).toHaveLength(2);
      expect(batches[1]).toHaveLength(2);
    });
  });

  describe("validateProcessPlan", () => {
    it("returns no errors for valid plan", () => {
      const errors = validateProcessPlan({
        type: "sequential",
        tasks: [
          { id: "t1", roleId: "a", title: "A" },
          { id: "t2", roleId: "b", title: "B", dependsOn: ["t1"] }
        ]
      });
      expect(errors).toHaveLength(0);
    });

    it("detects missing dependency", () => {
      const errors = validateProcessPlan({
        type: "sequential",
        tasks: [
          { id: "t1", roleId: "a", title: "A", dependsOn: ["nonexistent"] }
        ]
      });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("nonexistent");
    });

    it("detects self-dependency", () => {
      const errors = validateProcessPlan({
        type: "sequential",
        tasks: [
          { id: "t1", roleId: "a", title: "A", dependsOn: ["t1"] }
        ]
      });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("itself");
    });
  });
});
