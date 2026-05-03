import '../src/styles/theme.css';
import '../src/styles/lab.css';
import Menu from '../src/components/Menu';
import TopNav from '../src/components/TopNav';

// /disclaimer — site-wide legal / risk-disclosure page linked from the
// red Disclaimer affordance in every lab-footer across the site. Single
// content card, no charts, no Chat mount, no /api fetch. The lab-shell
// chrome (Menu + TopNav + Home + .lab-footer) is preserved so the page
// reads as a sibling of the rest of the labs rather than a free-floating
// document, but the body is intentionally short — the goal is "minimum
// surface area to convey the disclaimers", not an exhaustive legal
// brief. Every assertion in the body is meant to be verifiable from
// the public artifacts the page itself links to (the GitHub repo, the
// MIT LICENSE, Anthropic's published usage policies).
export default function App() {
  return (
    <div className="app-shell lab-shell">
      <header className="lab-header">
        <div className="lab-brand">
          <span
            className="lab-badge"
            title="Disclaimer · as-is mathematics, no advice, MIT-licensed, non-commercial"
          >
            <span className="lab-badge__desktop-text">Disclaimer</span>
            <span className="lab-badge__mobile-text">Disclaimer</span>
          </span>
        </div>
        <TopNav />
        <a
          href="/"
          className="lab-home-button lab-home-button--inline lab-home-button--split"
          aria-label="Return Home"
        >
          <span className="lab-home-button__desktop-text">Home</span>
          <span className="lab-home-button__mobile-text">Home</span>
        </a>
        <Menu />
      </header>

      <div className="card" style={{ padding: '1.4rem 1.5rem', margin: '1.25rem 0' }}>
        <div
          style={{
            fontFamily: "Calibri, 'Segoe UI', system-ui, sans-serif",
            fontSize: '0.7rem',
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--text-secondary)',
            marginBottom: '0.7rem',
          }}
        >
          Disclaimer
        </div>
        <div style={{ color: 'var(--text-secondary)', lineHeight: 1.65, fontSize: '0.95rem' }}>
          <p style={{ margin: '0 0 0.85rem' }}>
            Everything on this site is{' '}
            <strong style={{ color: 'var(--text-primary)' }}>
              mathematics presented as-is
            </strong>
            . No number, chart, level, regime label, or model output on any
            page of aigamma.com is a recommendation, a forecast, a trade
            signal, or financial advice of any kind. Every decision about
            what to do with what you read here is left entirely in your hands.
          </p>
          <p style={{ margin: '0 0 0.85rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Chatbots.</strong>{' '}
            The on-site chat surfaces stream responses from Anthropic's
            Claude models. The site is not responsible for any output you
            perceive as advice from the chatbot. The system prompts are
            engineered in good faith to steer the model away from
            recommending trades or expressing personal opinions on the
            direction of any market, and Anthropic's own usage policies
            and model training apply additional safety layers on top of
            that — but neither layer is a guarantee. Treat any chatbot
            response as a description of the math on the page you happen
            to be on, not as a directive about what to do next.
          </p>
          <p style={{ margin: '0 0 0.85rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Standard market disclaimers.</strong>{' '}
            Trading and investing involve substantial risk of loss,
            including the total loss of capital. Past performance is not
            indicative of future results. Options trading, in particular,
            is not suitable for every investor and can result in losses
            that exceed the initial premium. Nothing on this site is a
            solicitation, an offer, or a recommendation to buy, sell,
            hold, or hedge any security, derivative, or other financial
            instrument. Information may be incomplete, delayed, or
            inaccurate. Consult a qualified, licensed professional before
            acting on anything you see here.
          </p>
          <p style={{ margin: '0 0 0.85rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Open source, no commercial purpose.</strong>{' '}
            The site is open source under the MIT license. The full source
            tree is at{' '}
            <a
              href="https://github.com/aigamma/aigamma.com/"
              style={{ color: 'var(--accent-blue)', fontWeight: 600 }}
            >
              github.com/aigamma/aigamma.com
            </a>{' '}
            and can be inspected, copied, modified, or redistributed
            subject to the MIT terms. There are no commercial aspects to
            this site: no subscriptions, no paywalls, no affiliate links,
            no advertising, no data resale, no managed accounts, no
            brokered trades. The author built the platform as quantitative
            tooling to analyze markets for the author's own purposes and
            shares the tooling publicly{' '}
            <em>as-is, without warranty of any kind</em>, in the spirit
            of the MIT license itself — and not as a recommendation that
            anyone else use it for the same purpose.
          </p>
          <p style={{ margin: 0 }}>
            By using this site you acknowledge that you have read and
            accepted the above.
          </p>
        </div>
      </div>

      <footer className="lab-footer">
        <span className="lab-footer-line">
          AI Gamma · disclaimer · v0.1.0
        </span>
        <a href="/" className="lab-footer-home">Return Home</a>
        <a href="https://about.aigamma.com/" className="lab-footer-about">Who made this?</a>
        <a href="/disclaimer/" className="lab-footer-disclaimer">Disclaimer</a>
      </footer>
    </div>
  );
}
