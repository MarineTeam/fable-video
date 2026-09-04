import Link from "next/link";
import { PlayIcon } from "./icons";
import PushToggle from "./PushToggle";
import { resolveSiteName } from "../lib/siteName";

// `siteName` is resolved server-side and passed down from each page's
// getServerSideProps. resolveSiteName falls back to the env value and then
// the built-in default, so a page that doesn't pass one still renders a name
// rather than an empty header.
export default function AppShell({ user, admin, canNotify, siteName, children }) {
  const site = resolveSiteName(siteName);
  return (
    <div className="shell">
      <header className="shell-header">
        <div className="shell-header-inner">
          <Link href="/" className="brand">
            <span className="brand-mark">
              <PlayIcon size={14} />
            </span>
            <span>{site}</span>
          </Link>
          <nav className="shell-nav">
            <Link href="/" className="nav-link">
              Library
            </Link>
            {user ? (
              <Link href="/activity" className="nav-link">
                My activity
              </Link>
            ) : null}
            {admin ? (
              <Link href="/admin" className="nav-link">
                Admin
              </Link>
            ) : null}
            {canNotify ? <PushToggle /> : null}
            {user ? (
              <span className="user-chip" title={user.email}>
                {user.email}
              </span>
            ) : null}
            <a href="/auth/logout" className="btn btn-ghost btn-sm">
              Sign out
            </a>
          </nav>
        </div>
      </header>
      <main className="container">{children}</main>
      <footer className="shell-footer">
        Private video portal — access by invitation only.
      </footer>
    </div>
  );
}
