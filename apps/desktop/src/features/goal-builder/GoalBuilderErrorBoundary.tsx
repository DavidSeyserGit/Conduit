import { Component, type ErrorInfo, type ReactNode } from "react";
import { useGoalBuilderStore } from "../../stores/goal-builder-store.js";

interface Props { children: ReactNode }
interface State { error: Error | null }

export class GoalBuilderErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Goal Builder render failed", error, info.componentStack);
  }

  private recover = () => {
    useGoalBuilderStore.getState().reset();
    this.setState({ error: null });
  };

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-gray-50 px-6 text-center">
        <div className="max-w-lg rounded-2xl border border-red-200 bg-white p-6 shadow-sm">
          <div className="mx-auto mb-4 flex size-10 items-center justify-center rounded-full bg-red-50 font-semibold text-red-600">!</div>
          <h2 className="text-lg font-semibold text-gray-900">Goal Builder stopped unexpectedly</h2>
          <p className="mt-2 text-sm leading-6 text-gray-500">Your repository was not modified by this UI error. Start over to safely return to the prompt.</p>
          <button type="button" onClick={this.recover} className="mt-5 rounded-xl bg-gray-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-gray-800">Start over</button>
        </div>
      </div>
    );
  }
}
