import { useState, useEffect } from 'react';

export function useIsTauri() {
  const [isTauri, setIsTauri] = useState(false);

  useEffect(() => {
    // This check runs only on the client-side after the component mounts,
    // safely accessing the `window` object.
    setIsTauri(typeof window !== 'undefined' && !!window.__TAURI__);
  }, []);

  return isTauri;
}
