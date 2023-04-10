import React from "react";
import PageTitle from "../components/PageTitle";
import "./Violations.css";

const Violations: React.FC = () => {
  return (
    <div className="Violations">
      <PageTitle title="Violations" />
      <h2>Violations</h2>

      <p>
        This page has many <code>axe-core</code> violations.
      </p>

      <div className="Violations-color-contrast">
        <h3>Color contrast violations</h3>
        <ul>
          {Array(8)
            .fill(0)
            .map((_, i) => (
              <li key={i}>
                <span>Violation #{i + 1} ?</span>
              </li>
            ))}
        </ul>
      </div>

      <div className="Violations-image-alt">
        <h3>Image alt violations</h3>
        <ul>
          {Array(10)
            .fill(0)
            .map((_, i) => (
              <li key={i}>
                <img src={`https://placekitten.com/g/20${i}/30${i}`} />
              </li>
            ))}
        </ul>
      </div>
    </div>
  );
};

export default Violations;
