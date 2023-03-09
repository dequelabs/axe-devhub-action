import React from "react";
import { NavLink } from "react-router-dom";
import "./Header.css";

const Header: React.FC = () => {
  return (
    <header className="Header">
      <h1>App</h1>

      <nav className="Header-nav">
        <ul>
          <li>
            <NavLink to="/">Home</NavLink>
          </li>
          <li>
            <NavLink to="/violations">Violations</NavLink>
          </li>
        </ul>
      </nav>
    </header>
  );
};

export default Header;
