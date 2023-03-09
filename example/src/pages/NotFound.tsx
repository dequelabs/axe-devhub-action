import React from "react";
import PageTitle from "../components/PageTitle";
import "./NotFound.css";

const NotFound: React.FC = () => {
  return (
    <div className="NotFound">
      <PageTitle title="Not Found" />
      <h2>Not Found</h2>
    </div>
  );
};

export default NotFound;
