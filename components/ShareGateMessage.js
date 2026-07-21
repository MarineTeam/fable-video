// Shared "this link/bundle isn't available to you" card, used by both the
// single-share watch page and the bundle watch page so the gone/mismatch
// copy (and the privacy guarantee behind it — never reveal who a link or
// bundle was meant for) stays identical in one place.
export default function ShareGateMessage({ title, children, user }) {
  return (
    <div className="share-page">
      <div className="center-panel">
        <div className="card narrow-card">
          <h1 className="panel-title">{title}</h1>
          <div className="muted">{children}</div>
          <p className="muted small">
            Signed in as <strong>{user.email}</strong>
          </p>
          <a href="/auth/logout" className="btn btn-ghost">
            Sign out / switch account
          </a>
        </div>
      </div>
    </div>
  );
}
