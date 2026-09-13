import { useEffect, useRef, useState } from 'react';

/** Advance only while the illustration is visible and the person permits motion. */
export function usePresentation<T extends HTMLElement = HTMLElement>(count: number, interval: number) {
  const element = useRef<T>(null);
  const remaining = useRef(interval);
  const [step, setStep] = useState(0);
  const [paused, setPaused] = useState(false);
  const [focused, setFocused] = useState(false);
  const [visible, setVisible] = useState(false);
  const [reduced, setReduced] = useState(true);
  const [foreground, setForeground] = useState(true);
  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const preference = () => setReduced(media.matches);
    const visibility = () => setForeground(!document.hidden);
    preference(); visibility();
    media.addEventListener('change', preference);
    document.addEventListener('visibilitychange', visibility);
    const observer = new IntersectionObserver(([entry]) => setVisible(Boolean(entry?.isIntersecting)), { threshold: 0.15 });
    if (element.current) observer.observe(element.current);
    return () => { observer.disconnect(); media.removeEventListener('change', preference); document.removeEventListener('visibilitychange', visibility); };
  }, []);
  const running = !paused && !focused && !reduced && visible && foreground;
  useEffect(() => {
    if (!running) return;
    const started = performance.now();
    let fired = false;
    const timer = setTimeout(() => {
      fired = true; remaining.current = interval;
      setStep(value => (value + 1) % count);
    }, remaining.current);
    return () => {
      clearTimeout(timer);
      if (!fired) remaining.current = Math.max(0, remaining.current - (performance.now() - started));
    };
  }, [running, count, interval, step]);
  return { element, step, paused, setPaused, reduced, running,
    interaction: {
      onFocusCapture: () => setFocused(true),
      onBlurCapture: (event: React.FocusEvent<HTMLElement>) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); },
    },
  };
}
