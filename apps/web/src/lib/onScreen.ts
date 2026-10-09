/**
 * Whether an element has come on screen, for a panel that reads the chain
 * only once someone can see it (Your stack, which is further down the page
 * than most visits go).
 *
 * It stays true once it is: what was read is kept and cached, and a panel
 * that went back to "reading…" each time it scrolled into view would say it
 * knows less than it does. Without IntersectionObserver it is true at once,
 * since figures that never load are worse than figures read early.
 *
 * The ref is a callback, so an element mounted later (after the first-run
 * screen, say) is watched from the moment it appears.
 */

import { useEffect, useState } from "react";

export function useSeenOnScreen<T extends Element>(): [boolean, (element: T | null) => void] {
  const [element, setElement] = useState<T | null>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (seen || element === null) return;
    if (typeof IntersectionObserver === "undefined") {
      setSeen(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setSeen(true);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, seen]);
  return [seen, setElement];
}
