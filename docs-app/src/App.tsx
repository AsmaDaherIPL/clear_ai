import { BrowserRouter, Routes, Route } from 'react-router-dom';
import ProductDefinition from './pages/ProductDefinition';
import Process from './pages/Process';
import Architecture from './pages/Architecture';
import Reference from './pages/Reference';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/"             element={<ProductDefinition />} />
        <Route path="/process"      element={<Process />} />
        <Route path="/architecture" element={<Architecture />} />
        <Route path="/reference"    element={<Reference />} />
      </Routes>
    </BrowserRouter>
  );
}
