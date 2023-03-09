import React from "react";

interface Props {
  title: string;
}

const PageTitle: React.FC<Props> = ({ title }) => {
  React.useEffect(() => {
    const previousTitle = document.title;
    document.title = `${title} | App`;
    return () => {
      document.title = previousTitle;
    };
  }, [title]);

  return null;
};

export default PageTitle;
