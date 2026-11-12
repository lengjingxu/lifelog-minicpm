import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

if (import.meta.env.DEV || import.meta.env.VITE_BENCH_BUILD === "1") {
  // 开发期或 bench 专用构建才加载；正式发布构建两者都是 false，整段被剔除
  void import("./bench").then((mod) => mod.startBenchIfEnabled());
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
