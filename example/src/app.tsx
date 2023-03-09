import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import App from "./components/App";
import Home from "./pages/Home";
import NotFound from "./pages/NotFound";
import Violations from "./pages/Violations";

import "./app.css";

const container = document.getElementById("root");
const root = createRoot(container);

root.render(
  <BrowserRouter>
    <App>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/violations" element={<Violations />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </App>
  </BrowserRouter>
);
