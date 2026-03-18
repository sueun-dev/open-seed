/**
 * Process Abstraction (inspired by CrewAI).
 *
 * Defines execution strategies that decouple WHAT agents do from HOW they coordinate.
 * Same agents + tasks can run under different process types:
 *
 * - Sequential: tasks execute one after another, output chains forward
 * - Hierarchical: orchestrator delegates to specialists, aggregates results
 * - Parallel: independent tasks run concurrently, sync at barriers
 */

export type ProcessType = "sequential" | "hierarchical" | "parallel";

export interface ProcessTask {
  id: string;
  roleId: string;
  title: string;
  dependsOn?: string[];
}

export interface ProcessResult {
  taskId: string;
  roleId: string;
  output: unknown;
  status: "completed" | "failed";
  durationMs: number;
}

export interface ProcessPlan {
  type: ProcessType;
  tasks: ProcessTask[];
}

/**
 * Analyze task dependencies and choose the optimal process type.
 */
export function selectProcess(tasks: ProcessTask[]): ProcessType {
  if (tasks.length <= 1) return "sequential";

  const hasDependencies = tasks.some((t) => t.dependsOn && t.dependsOn.length > 0);
  if (!hasDependencies) {
    // No dependencies — all tasks can run in parallel
    return tasks.length >= 3 ? "parallel" : "sequential";
  }

  // Check if it's a simple chain (each depends on previous)
  const isChain = tasks.every((t, i) => {
    if (i === 0) return !t.dependsOn || t.dependsOn.length === 0;
    return t.dependsOn?.length === 1 && t.dependsOn[0] === tasks[i - 1].id;
  });

  if (isChain) return "sequential";

  // Complex dependency graph → hierarchical with orchestrator
  return "hierarchical";
}

/**
 * Build execution batches from task dependencies.
 * Tasks in the same batch can run in parallel.
 */
export function buildExecutionBatches(tasks: ProcessTask[]): ProcessTask[][] {
  const completed = new Set<string>();
  const remaining = [...tasks];
  const batches: ProcessTask[][] = [];

  while (remaining.length > 0) {
    const batch = remaining.filter((t) => {
      if (!t.dependsOn || t.dependsOn.length === 0) return true;
      return t.dependsOn.every((dep) => completed.has(dep));
    });

    if (batch.length === 0) {
      // Circular dependency or unresolvable — force remaining into one batch
      batches.push([...remaining]);
      break;
    }

    batches.push(batch);
    for (const t of batch) {
      completed.add(t.id);
      const idx = remaining.indexOf(t);
      if (idx >= 0) remaining.splice(idx, 1);
    }
  }

  return batches;
}

/**
 * Validate that a process plan has no broken dependencies.
 */
export function validateProcessPlan(plan: ProcessPlan): string[] {
  const errors: string[] = [];
  const taskIds = new Set(plan.tasks.map((t) => t.id));

  for (const task of plan.tasks) {
    if (task.dependsOn) {
      for (const dep of task.dependsOn) {
        if (!taskIds.has(dep)) {
          errors.push(`Task "${task.id}" depends on unknown task "${dep}"`);
        }
        if (dep === task.id) {
          errors.push(`Task "${task.id}" depends on itself`);
        }
      }
    }
  }

  return errors;
}
