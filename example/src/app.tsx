import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import App from "./components/App";
import Home from "./pages/Home";
import MinorViolations from "./pages/MinorViolations";
import NotFound from "./pages/NotFound";
import SeriousViolations from "./pages/SeriousViolations";

import "./app.css";

const container = document.getElementById("root");
const root = createRoot(container);

root.render(
  <BrowserRouter>
    <App>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/minor-violations" element={<MinorViolations />} />
        <Route path="/serious-violations" element={<SeriousViolations />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </App>
  </BrowserRouter>
);
