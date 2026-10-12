/**
 * Authentic MOTION brand mark supplied by the owner on 2026-10-12.
 * Preserve the uploaded artwork rather than recreating its typography and
 * brackets using HTML/CSS. This shared component serves all MOTION headers.
 */
export function MotionLogo() {
  return (
    <a className="motion-logo" href="#/" aria-label="MOTION overview">
      <img
        className="motion-logo-image"
        src="/motion-official-logo.png"
        alt=".motion"
        width={288}
        height={263}
        decoding="async"
      />
    </a>
  )
}
