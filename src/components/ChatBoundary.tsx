// Keeps a rendering fault in the chat from blanking the whole workspace.
// Nothing is retried automatically; the user chooses to reload the chat.
import { Component, type ReactNode } from 'react';

export default class ChatBoundary extends Component<{ children: ReactNode; resetKey: string }, { error: Error | null; key: string }> {
  state = { error: null as Error | null, key: this.props.resetKey };
  static getDerivedStateFromError(error: Error) { return { error }; }
  static getDerivedStateFromProps(props: { resetKey: string }, state: { error: Error | null; key: string }) {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }
  render() {
    if (!this.state.error) return this.props.children;
    return <div className="chat-fallback" role="alert">
      <div>
        <h2>This chat could not be displayed</h2>
        <p>Your case data is unchanged. Reload the chat to try again, or open another chat.</p>
        <details className="turn-detail"><summary>Show details</summary><pre>{this.state.error.message}</pre></details>
        <button type="button" className="secondary" onClick={() => this.setState({ error: null })}>Reload chat</button>
      </div>
    </div>;
  }
}
