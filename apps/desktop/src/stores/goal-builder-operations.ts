export interface CancellableGoalRuntime {
  cancel(runId: string): Promise<void>;
  cancelActive(): Promise<void>;
}

export interface GoalBuilderOperation<TRuntime extends CancellableGoalRuntime> {
  readonly id: number;
  readonly runtime: TRuntime;
}

/** Owns the one runtime allowed to mutate the Goal Builder at a time. */
export class GoalBuilderOperationCoordinator<TRuntime extends CancellableGoalRuntime> {
  private active: GoalBuilderOperation<TRuntime> | null = null;
  private nextId = 0;

  get busy(): boolean {
    return this.active !== null;
  }

  begin(createRuntime: () => TRuntime): GoalBuilderOperation<TRuntime> | null {
    if (this.active) return null;
    const operation = { id: ++this.nextId, runtime: createRuntime() };
    this.active = operation;
    return operation;
  }

  isCurrent(operation: GoalBuilderOperation<TRuntime>): boolean {
    return this.active === operation;
  }

  finish(operation: GoalBuilderOperation<TRuntime>): void {
    if (this.active === operation) this.active = null;
  }

  async cancel(runId: string | null, createFallbackRuntime: () => TRuntime): Promise<void> {
    const operation = this.active;
    this.active = null;
    if (operation) {
      await operation.runtime.cancelActive();
      return;
    }
    if (runId) await createFallbackRuntime().cancel(runId);
  }

  reset(): void {
    const operation = this.active;
    this.active = null;
    if (operation) void operation.runtime.cancelActive().catch(() => undefined);
  }
}

export async function handoffImplementation(
  startImplementation: () => Promise<void>,
  onHandedOff: () => void,
): Promise<void> {
  const implementation = startImplementation();
  onHandedOff();
  await implementation;
}
