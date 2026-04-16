import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom';
import ProductDefinition from './pages/ProductDefinition';
import Process from './pages/Process';
import Architecture from './pages/Architecture';
import Reference from './pages/Reference';

// Scroll to top on route change (but respect anchor links)
function ScrollToTop() {
  const { pathname, hash } = useLocation();

  useEffect(() => {
    // If there's a hash (anchor link), let the browser handle it
    if (hash) {
      const el = document.querySelector(hash);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth' });
      }
      return;
    }
    // Otherwise scroll to top
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, [pathname, hash]);

  return null;
}

export default function App() {
  return (
    <BrowserRouter>
      <ScrollToTop />
      <Routes>
        <Route path="/"             element={<ProductDefinition />} />
        <Route path="/process"      element={<Process />} />
        <Route path="/architecture" element={<Architecture />} />
        <Route path="/reference"    element={<Reference />} />
      </Routes>
    </BrowserRouter>
  );
}
