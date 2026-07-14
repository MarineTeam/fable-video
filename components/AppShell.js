import Link from "next/link";
import { PlayIcon } from "./icons";
import PushToggle from "./PushToggle";

const SITE_NAME = process.env.NEXT_PUBLIC_SITE_NAME || "Marine Video Portal";

export default function AppShell({ user, admin, canNotify, children }) {
  return (
    <div className="shell">
      <header className="shell-header">
        <div className="shell-header-inner">
          <Link href="/" className="brand">
            <span className="brand-mark">
              <PlayIcon size={14} />
            </span>
            <span>{SITE_NAME}</span>
          </Link>
          <nav className="shell-nav">
            <Link href="/" className="nav-link">
              Library
            </Link>
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
