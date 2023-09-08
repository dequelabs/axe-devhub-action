import React from "react";
import PageTitle from "../components/PageTitle";
import "./MinorViolations.css";

const Violations: React.FC = () => {
  return (
    <div className="Violations">
      <PageTitle title="Minor Violations" />
      <h2>Violations</h2>

      <p>
        This page has many minor-impact <code>axe-core</code> violations.
      </p>

      {
        // TODO: add some minor impact violations
      }
    </div>
  );
};

export default Violations;
