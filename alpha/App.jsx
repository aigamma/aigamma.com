import '../src/styles/theme.css';
import '../src/styles/page.css';
import ErrorBoundary from '../src/ErrorBoundary';
import Menu from '../src/components/Menu';
import TopNav from '../src/components/TopNav';
import SlotA, { slotName as slotAName } from './slots/SlotA';
import SlotB, { slotName as slotBName } from './slots/SlotB';

export default function App() {
  return (
    <div className="app-shell page-shell">
      <header className="page-header">
        <div className="page-brand">
          <span
            className="page-badge"
            title="Alpha · pre-β, software-stage sense"
          >
            Alpha Lab
          </span>
        </div>
        <TopNav />
        <Menu />
      </header>

      <div className="page-warning">
        <strong>Experimental.</strong>{' '}
        A two-slot A/B scratch pad for rough-cut ideas. Math, data, and
        rendering may be incomplete, incorrect, or change without notice.
      </div>

      <section className="page-slot">
        <div className="page-slot-label">{slotAName}</div>
        <ErrorBoundary><SlotA /></ErrorBoundary>
      </section>

      <section className="page-slot">
        <div className="page-slot-label">{slotBName}</div>
        <ErrorBoundary><SlotB /></ErrorBoundary>
      </section>

      <footer className="page-footer">
        <span className="page-footer-line">
          AI Gamma · α lab · software-stage sense · v1.1.4
        </span>
        <a href="/disclaimer/" className="page-footer-disclaimer">Disclaimer</a>
        <a href="/" className="page-footer-home">Return Home</a>
        <a href="https://about.aigamma.com/" className="page-footer-about">Who made this?</a>
      </footer>
    </div>
  );
}
