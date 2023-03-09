import React from "react";
import PageTitle from "../components/PageTitle";
import "./Home.css";

const Home: React.FC = () => {
  return (
    <div className="Home">
      <PageTitle title="Home" />
      <h2>Home</h2>

      <p>
        This page has no <code>axe-core</code> violations.
      </p>
    </div>
  );
};

export default Home;
