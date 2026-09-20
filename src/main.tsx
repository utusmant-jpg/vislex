import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: string }> {
  state = { error: '' };
  static getDerivedStateFromError(error: Error) { return { error: error.message }; }
  render() { return this.state.error ? <main style={{ padding: 40 }}><h1>The workspace could not render</h1><p>Saved case data has not been changed. Reload the application to reopen the workspace.</p><pre>{this.state.error}</pre><button onClick={() => window.location.reload()}>Reload workspace</button></main> : this.props.children; }
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><ErrorBoundary><App /></ErrorBoundary></React.StrictMode>);
