import webpack from "webpack";
import HTMLWebpackPlugin from "html-webpack-plugin";
import path from "path";

const config: webpack.Configuration = {
  entry: path.join(__dirname, "src", "app.tsx"),
  output: {
    path: path.join(__dirname, "dist"),
    filename: "[name].js",
    publicPath: "/",
  },
  devtool: "cheap-module-source-map",
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        exclude: /node_modules/,
        use: "ts-loader",
      },
      {
        test: /\.css$/,
        use: ["style-loader", "css-loader", "postcss-loader"],
      },
    ],
  },
  plugins: [
    new HTMLWebpackPlugin({
      template: path.join(__dirname, "src", "index.html"),
    }),
  ],
  resolve: { extensions: [".ts", ".tsx", ".js"] },
};

export default config;
