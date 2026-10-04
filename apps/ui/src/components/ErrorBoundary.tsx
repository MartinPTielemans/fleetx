/** A view that throws while rendering shows what went wrong, and the rest of the app keeps working. */
import { AlertTriangleIcon, RefreshCwIcon } from "lucide-react";
import { Component, type ReactNode } from "react";

import { Button } from "./ui/button";
import { Empty } from "./ui/empty";

export class ErrorBoundary extends Component<{ children: ReactNode; /** Changing it clears the error: the view the user moved to. */ resetKey: string }, { error: unknown }> {
  override state: { error: unknown } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  override componentDidUpdate(previous: { resetKey: string }) {
    if (previous.resetKey !== this.props.resetKey && this.state.error !== null) this.setState({ error: null });
  }

  override render() {
    if (this.state.error === null) return this.props.children;
    const message = this.state.error instanceof Error ? this.state.error.message : String(this.state.error);
    return (
      <div className="flex h-full items-center justify-center p-8">
        <Empty icon={<AlertTriangleIcon className="text-destructive" />} title="This view broke">
          <span className="block break-words">{message}</span>
          <Button className="mt-4" size="sm" variant="outline" onClick={() => this.setState({ error: null })}>
            <RefreshCwIcon />
            Try again
          </Button>
        </Empty>
      </div>
    );
  }
}
