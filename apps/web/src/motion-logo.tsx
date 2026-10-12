/**
 * MOTION suite identity: bracketed .motion wordmark.
 * The old two-letter/monogram tile is not the header brand.
 * Text remains crisp on iPhone and accessible at browser zoom.
 */
export function MotionLogo() {
  return (
    <a className="motion-logo" href="#/" aria-label=".motion — overview">
      <span className="motion-logo-bracket" aria-hidden="true">[</span>
      <span className="motion-logo-type">
        <span className="motion-logo-dot">.</span>motion
      </span>
      <span className="motion-logo-bracket" aria-hidden="true">]</span>
    </a>
  )
}
