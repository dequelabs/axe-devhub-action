import React from "react";
import "./App.css";
import Header from "./Header";

interface Props {
  children: React.ReactNode;
}

const App: React.FC<Props> = ({ children }) => {
  return (
    <div className="App">
      <Header />
      <main className="App-content">{children}</main>
    </div>
  );
};

export default App;
