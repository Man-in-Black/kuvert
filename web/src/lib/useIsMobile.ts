import { useEffect, useState } from 'react';

const QUERY = '(max-width: 767px)';

/** true unterhalb der md-Breite (768 px) */
export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() => typeof window !== 'undefined' && window.matchMedia(QUERY).matches);
  useEffect(() => {
    const m = window.matchMedia(QUERY);
    const on = () => setMobile(m.matches);
    on();
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return mobile;
}
